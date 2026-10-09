import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../src/social/ledger.ts";
import type { Evidence } from "../src/social/types.ts";
import { isSignature, isSolanaAddress } from "../src/social/validate.ts";
import { CLMM_F, DEX, DEX_OBSERVED_AT, HOLDERS, MINTS_RPC, POSTS, POSTS_OBSERVED_AT, SLOTS } from "./fixtures/social/data.ts";
import { buildPhasesLedger } from "./fixtures/social/ledger.ts";
import { F_ROUND_TRIPS, MINT, POOL_BALANCES, SIG, SIG_SLOT, WALLET } from "./fixtures/social/onchain.ts";

/**
 * Regression tests built from the results of DETECTIVE Phases 2, 3, 4 and 4B.
 * Local fixtures only: no network, no Apify, no trade.
 */

const mints = Object.values(MINT);

// ───────────── Phase 2 — ten X posts ─────────────
test("Phase 2: ten posts, nine cite a contract, seven distinct contracts, one post without contract", () => {
  assert.equal(POSTS.length, 10);
  assert.equal(new Set(POSTS.map((p) => p.id)).size, 10);
  const withCa = POSTS.filter((p) => p.contracts.length === 1);
  assert.equal(withCa.length, 9);
  assert.equal(POSTS.filter((p) => p.contracts.length === 0).length, 1);
  assert.equal(POSTS.find((p) => p.contracts.length === 0)!.n, 1);
  const distinct = new Set(withCa.map((p) => p.contracts[0]));
  assert.equal(distinct.size, 7);
  assert.deepEqual([...distinct].sort(), [...mints].sort());
  for (const m of distinct) assert.ok(isSolanaAddress(m));
});

test("Phase 2: duplicates and templates are visible in the data", () => {
  const byN = (n: number) => POSTS.find((p) => p.n === n)!;
  // same contract cited by two posts
  assert.equal(byN(6).contracts[0], MINT.A);
  assert.equal(byN(10).contracts[0], MINT.A);
  assert.equal(byN(3).contracts[0], MINT.C);
  assert.equal(byN(9).contracts[0], MINT.C);
  // same author, near-identical promotion, two minutes apart
  assert.equal(byN(3).author, byN(9).author);
  assert.equal(Date.parse(byN(3).createdAt) - Date.parse(byN(9).createdAt), 90_000);
  // same bot, two different contracts (the two "Cl*nker")
  assert.equal(byN(2).author, byN(10).author);
  assert.notEqual(byN(2).contracts[0], byN(10).contracts[0]);
  // two accounts, one "airdrop" host
  assert.notEqual(byN(5).author, byN(8).author);
  assert.deepEqual(byN(5).linkHosts, ["memes-airdrop.netlify.app"]);
  assert.deepEqual(byN(8).linkHosts, ["memes-airdrop.netlify.app"]);
});

test("Phase 2: the verified-account badge carries no information, engagement is almost nil", () => {
  assert.ok(POSTS.every((p) => p.blueVerified));
  assert.equal(POSTS.reduce((s, p) => s + p.likes, 0), 1);
  assert.equal(POSTS.reduce((s, p) => s + p.retweets, 0), 1);
  assert.ok(POSTS.filter((p) => p.views <= 25).length >= 7);
  assert.ok(POSTS.every((p) => Date.parse(p.createdAt) <= Date.parse(POSTS_OBSERVED_AT)));
  assert.ok(POSTS.every((p) => p.createdAt >= "2026-10-09T11:42:00Z" && p.createdAt <= "2026-10-09T11:45:00Z"));
});

// ───────────── Phase 3 — DEX Screener ─────────────
test("Phase 3: seven contracts found, names and tickers as announced, quote tokens as observed", () => {
  assert.deepEqual(Object.keys(DEX).sort(), [...mints].sort());
  assert.deepEqual([DEX[MINT.A]!.symbol, DEX[MINT.B]!.symbol], ["Cl*nker", "Cl*nker"]);
  assert.equal(DEX[MINT.C]!.symbol, "QUANTUM");
  assert.equal(DEX[MINT.C]!.name, "QuantumCoin");
  assert.equal(DEX[MINT.D]!.symbol, "FOXTILKI");
  assert.equal(DEX[MINT.E]!.symbol, "OCTO");
  assert.equal(DEX[MINT.F]!.name, "Gensyn");
  assert.equal(DEX[MINT.G]!.name, "Alon Cohen");
  assert.equal(DEX[MINT.B]!.quoteSymbol, "ANTHROPIC");
  assert.equal(DEX[MINT.E]!.quoteSymbol, "SPYx");
  assert.equal(DEX[MINT.F]!.quoteSymbol, "USDC");
  for (const m of [MINT.A, MINT.C, MINT.D, MINT.G]) assert.equal(DEX[m]!.quoteSymbol, "SOL");
  assert.ok(Date.parse(DEX_OBSERVED_AT) > Date.parse(POSTS_OBSERVED_AT) - 3_600_000);
});

test("Phase 3: the anomalies seen in the snapshot", () => {
  const f = DEX[MINT.F]!;
  assert.ok(Math.abs(f.liquidityUsd - f.marketCap) / f.marketCap < 0.01, "F: displayed liquidity ≈ market cap");
  assert.equal(f.buysH24 + f.sellsH24, 22);
  assert.ok(f.volumeH24 / f.marketCap < 0.01);
  assert.ok(DEX[MINT.B]!.volumeH24 / DEX[MINT.B]!.marketCap > 20, "B: volume ≫ market cap");
  assert.ok(DEX[MINT.C]!.volumeH24 / DEX[MINT.C]!.marketCap > 30, "C: volume ≫ market cap");
  assert.equal(DEX[MINT.D]!.pairCreatedAt.slice(0, 10), "2026-08-23"); // the "new" token of post 4 is 46 days old
  assert.equal(DEX[MINT.F]!.pairCreatedAt.slice(0, 10), "2026-07-01");
  assert.ok(DEX[MINT.A]!.priceChangeH24! < -90);
  assert.deepEqual(DEX[MINT.E]!.websites, ["https://octoprotocol.io/"]); // not the host used in post 5
});

test("Phase 3: A, C and F pools are the owners of their token accounts; B's CPMM pool is not", () => {
  assert.equal(DEX[MINT.A]!.pairAddress, HOLDERS[MINT.A]!.poolOwner);
  assert.equal(DEX[MINT.C]!.pairAddress, HOLDERS[MINT.C]!.poolOwner);
  assert.equal(DEX[MINT.F]!.pairAddress, HOLDERS[MINT.F]!.poolOwner);
  assert.notEqual(DEX[MINT.B]!.pairAddress, HOLDERS[MINT.B]!.poolOwner); // the vault authority, not the pair address
  assert.deepEqual(DEX[MINT.B]!.pairLabels, ["CPMM"]);
  assert.deepEqual(DEX[MINT.F]!.pairLabels, ["CLMM"]);
});

// ───────────── Phase 4 — mint authorities, extensions, holders ─────────────
test("Phase 4: authorities and Token-2022 extensions of A and B (raw mint decoded)", () => {
  const a = MINTS_RPC[MINT.A]!;
  const b = MINTS_RPC[MINT.B]!;
  for (const m of [a, b]) {
    assert.equal(m.mintAuthority, null);
    assert.equal(m.freezeAuthority, null);
    assert.equal(m.decimals, 6);
  }
  assert.deepEqual(a.extensionTypes, [18, 19]); // metadataPointer, tokenMetadata
  assert.equal(a.transferFee, null);
  assert.deepEqual(b.extensionTypes, [18, 1, 19]); // + TransferFeeConfig
  assert.equal(b.accountSize, 480);
  assert.equal(b.transferFee!.bps, 100);
  assert.equal(b.transferFee!.authority, WALLET.bFeeAuthority);
  assert.equal(b.transferFee!.withdrawAuthority, WALLET.bFeeAuthority);
  assert.ok(Math.abs(b.transferFee!.withheldRaw / Number(b.supplyRaw) - 0.000856) < 0.00001);
});

test("Phase 4: complete holder distributions", () => {
  const h = (m: string) => HOLDERS[m]!;
  assert.equal(h(MINT.A).poolPct, 93.21);
  assert.equal(h(MINT.F).poolPct, 99.39);
  assert.equal(h(MINT.B).poolPct, 22.73);
  assert.equal(h(MINT.C).poolPct, 20.88);
  assert.equal(h(MINT.A).holders, 122);
  assert.equal(h(MINT.F).holders, 27);
  // outside the pool: F and A are not concentrated in a wallet, C is the most concentrated
  assert.ok(h(MINT.F).nonPoolTop20Pct < 1);
  assert.ok(h(MINT.A).nonPoolTop10Pct < 5);
  assert.ok(h(MINT.C).nonPoolTop20Pct > 35);
  assert.ok(h(MINT.C).nonPoolTop20Pct > h(MINT.B).nonPoolTop20Pct);
  for (const m of [MINT.A, MINT.B, MINT.C, MINT.F]) {
    const x = h(m);
    assert.ok(x.nonPoolTop1Pct <= x.nonPoolTop5Pct && x.nonPoolTop5Pct <= x.nonPoolTop10Pct && x.nonPoolTop10Pct <= x.nonPoolTop20Pct);
  }
  const f = POOL_BALANCES.F;
  assert.ok(Math.abs((100 * f.tokens) / h(MINT.F).supply - h(MINT.F).poolPct) < 0.01);
  assert.ok(Math.abs((100 * POOL_BALANCES.A.tokens) / h(MINT.A).supply - 94.28) < 0.01); // before later trades moved it to 93.21
});

// ───────────── Phase 4B — slots, funding, CLMM ─────────────
test("Phase 4B: the three early recipients of A signed their own transaction in the creation slot", () => {
  const create = SLOTS.A_create!;
  for (const [key, payer] of [["A_r1", WALLET.aRecipient1], ["A_r2", WALLET.aRecipient2], ["A_r3", WALLET.aRecipient3]] as const) {
    assert.equal(SLOTS[key]!.slot, create.slot, key);
    assert.equal(SLOTS[key]!.blockTime, create.blockTime, key);
    assert.equal(SLOTS[key]!.feePayer, payer, key);
  }
  assert.equal(create.feePayer, WALLET.aCreator);
  assert.equal(create.signature, SIG.aCreate);
  assert.equal(SIG_SLOT.aCreatorFundsRecipient2 < create.slot, true);
  assert.equal(SIG_SLOT.aFunderFundsRecipient3 < SIG_SLOT.aFunderFundsCreator, true, "the common funder paid recipient 3 before the creator");
});

test("Phase 4B: QUANTUM — funding, creation, sniper, sale and return of funds in slots", () => {
  const s = SLOTS;
  assert.equal(s.C_create!.feePayer, WALLET.cCreator);
  assert.equal(s.C_fund!.feePayer, WALLET.cFunder);
  assert.equal(s.C_b1!.slot, s.C_create!.slot, "sniper buys in the creation slot");
  assert.equal(s.C_b1!.feePayer, WALLET.cSniper);
  assert.equal(s.C_b4!.slot - s.C_create!.slot, 12);
  assert.equal(s.C_b5!.slot - s.C_create!.slot, 16);
  assert.equal(s.C_create!.slot - s.C_fund!.slot, 1983);
  assert.equal(s.C_sell!.slot - s.C_create!.slot, 484);
  assert.equal(s.C_ret!.slot - s.C_create!.slot, 666);
  const t = (k: string) => Date.parse(s[k]!.blockTime);
  assert.equal((t("C_create") - t("C_fund")) / 1000, 528);
  assert.equal((t("C_sell") - t("C_create")) / 1000, 130);
  assert.equal((t("C_ret") - t("C_create")) / 1000, 178);
  // the fixture signatures and slots agree with what the RPC returned
  for (const [k, sig] of [["C_create", SIG.cCreate], ["C_b1", SIG.cSniperBuy], ["C_fund", SIG.cFunding], ["C_sell", SIG.cCreatorSell], ["C_ret", SIG.cReturn], ["B_first", SIG.bFirstTx]] as const) assert.equal(s[k]!.signature, sig, k);
});

test("Phase 4B: the sniper of C was funded by four wallets for exactly 80 SOL", () => {
  assert.equal(Math.round((32.716 + 22.65 + 22.626 + 2.008) * 1000) / 1000, 80);
  assert.equal(WALLET.cSniperFunders.length, 4);
  assert.equal(new Set(WALLET.cSniperFunders).size, 4);
});

test("Phase 4B: B's first transaction comes 53 slots before the creation of A", () => {
  assert.equal(SLOTS.A_create!.slot - SLOTS.B_first!.slot, 53);
  assert.equal(SLOTS.B_first!.feePayer, WALLET.bFirstTxPayer);
  assert.equal(SIG_SLOT.bFirstTx, SLOTS.B_first!.slot);
});

test("Phase 4B: F's CLMM position — range, liquidity and a single position", () => {
  const c = CLMM_F;
  assert.equal(c.poolAddress, HOLDERS[MINT.F]!.poolOwner);
  assert.equal(c.tickSpacing, 1);
  assert.equal(c.tickCurrent, c.tickLower, "price sits on the lower bound: no liquidity below");
  assert.equal(c.tickLower, -33784);
  assert.equal(c.tickUpper, -29732);
  assert.equal(c.positionLiquidity, c.liquidity, "the single position is all of the active liquidity");
  const lower = 1.0001 ** c.tickLower;
  const upper = 1.0001 ** c.tickUpper;
  assert.ok(Math.abs(upper / lower - 1 - 0.4996) < 0.0005);
  const sqrt = Number(BigInt(c.sqrtPriceX64)) / 2 ** 64;
  assert.ok(Math.abs(sqrt * sqrt - DEX[MINT.F]!.marketCap / 999_998_295.232355) < 0.0005, "pool price = DEX price");
});

test("Phase 4B: F's round-trip legs rebuild the 24 h volume displayed by DEX Screener", () => {
  const legs = [...F_ROUND_TRIPS.large.flat(), ...F_ROUND_TRIPS.medium.flat(), ...F_ROUND_TRIPS.tiny.flat()].reduce((s, x) => s + x, 0);
  const dexVolume = DEX[MINT.F]!.volumeH24;
  assert.ok(Math.abs(legs - dexVolume) / dexVolume < 0.002, `${legs} vs ${dexVolume}`);
  for (const [buy, sell] of [...F_ROUND_TRIPS.large, ...F_ROUND_TRIPS.medium, ...F_ROUND_TRIPS.tiny]) assert.ok(Math.abs(buy - sell) / buy < 0.001, "each cycle returns (almost) the same USDC");
});

test("fixtures: every signature is valid base58 of 64 bytes, every address of 32 bytes, slots are consistent", () => {
  for (const s of Object.values(SIG)) assert.ok(isSignature(s), s);
  for (const a of [...Object.values(MINT), ...Object.values(WALLET).flat()]) assert.ok(isSolanaAddress(a), a);
  assert.equal(Object.keys(SIG).length, Object.keys(SIG_SLOT).length);
  assert.ok(SIG_SLOT.fMint < SIG_SLOT.fPoolCreate && SIG_SLOT.fPoolCreate < SIG_SLOT.fLpOwnerFunding && SIG_SLOT.fLpOwnerFunding < SIG_SLOT.fImpostorMint);
});

// ───────────── The ledger built from all four phases ─────────────
test("the Phase 2–4B ledger builds, counts match the reports, and round-trips through JSON", () => {
  const { ledger } = buildPhasesLedger();
  assert.deepEqual(ledger.countByStatus(), { FACT: 49, INDICATION: 9, HYPOTHESIS: 4, UNVERIFIED: 7 });
  assert.equal(ledger.size, 69);
  assert.deepEqual(ledger.mints().sort(), [...mints].sort());
  const back = EvidenceLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.deepEqual(back.all().map((e) => e.id), ledger.all().map((e) => e.id));
});

test("the ledger respects the discipline of the reports", () => {
  const { ledger } = buildPhasesLedger();
  for (const e of ledger.all()) {
    assert.ok(e.observedAt.endsWith("Z"));
    if (e.status === "FACT") assert.ok(e.signature || e.slot !== null || e.addresses.length || e.url, `anchor: ${e.summary}`);
    if (e.status !== "FACT") assert.ok(e.limits.length > 0 || e.status === "UNVERIFIED", `limits: ${e.summary}`);
    if (e.status === "UNVERIFIED") assert.ok(e.missing.length > 0, `missing: ${e.summary}`);
    if (e.status === "HYPOTHESIS") {
      assert.ok(e.basedOn.length > 0);
      for (const b of e.basedOn) assert.ok(["FACT", "INDICATION"].includes(ledger.get(b)!.status));
    }
    // Wording: summaries state observations, never intent or fraud.
    if (e.status !== "FACT") assert.doesNotMatch(e.summary, /fraude|arnaque|scam|rug ?pull|wash trading|manipul/i, e.summary);
  }
});

/** Signatures reachable by following `basedOn` links down to the FACTs. */
function provenance(ledger: EvidenceLedger, id: string, seen = new Set<string>()): Set<string> {
  const e = ledger.get(id) as Evidence;
  if (seen.has(id)) return new Set();
  seen.add(id);
  const sigs = new Set<string>(e.signature ? [e.signature] : []);
  for (const b of e.basedOn) for (const s of provenance(ledger, b, seen)) sigs.add(s);
  return sigs;
}

test("every hypothesis can be traced back to signed on-chain facts", () => {
  const { ledger, ids } = buildPhasesLedger();
  const a = provenance(ledger, ids["hyp:aOperator"]!);
  for (const s of [SIG.aRecipient1, SIG.aCreatorFundsRecipient2, SIG.aFunderFundsRecipient3, SIG.aFunderFundsCreator, SIG.aLookalikeDust]) assert.ok(a.has(s), s);
  const c = provenance(ledger, ids["hyp:cOperator"]!);
  for (const s of [SIG.cFunding, SIG.cReturn, SIG.cCreate, SIG.cCreatorSell]) assert.ok(c.has(s), s);
  const fAuto = provenance(ledger, ids["hyp:fAutomation"]!);
  assert.ok(fAuto.has(SIG.fRoundTripBuy));
  const fImp = provenance(ledger, ids["hyp:fImpersonation"]!);
  for (const s of [SIG.fLpOwnerFunding, SIG.fImpostorMint]) assert.ok(fImp.has(s), s);
});

test("what could not be established is recorded as UNVERIFIED, not silently dropped", () => {
  const { ledger, ids } = buildPhasesLedger();
  for (const name of ["claim:cMultiple", "claim:cMascot", "id:F", "pool:B", "gap:B", "gap:A", "claim:G"]) assert.equal(ledger.get(ids[name]!)!.status, "UNVERIFIED", name);
  assert.ok(ledger.get(ids["id:F"]!)!.missing.includes("adresse officielle publiée par la fondation Gensyn"));
  assert.ok(ledger.get(ids["gap:A"]!)!.limits.some((l) => /403/.test(l)), "the plan limitation that blocked the funding lookup is recorded");
});

test("the comparison A vs B is a negative finding with its limits, not a claim of independence", () => {
  const { ledger, ids } = buildPhasesLedger();
  const cmp = ledger.get(ids["cmp:AvsB"]!)!;
  assert.equal(cmp.mint, null);
  assert.equal(cmp.status, "INDICATION");
  assert.ok(cmp.limits.some((l) => /absence de preuve/.test(l)));
});

test("F: the displayed liquidity is not read as depth — the pool entry says so", () => {
  const { ledger, ids } = buildPhasesLedger();
  assert.ok(ledger.get(ids["pool:F"]!)!.limits.some((l) => /PAS la profondeur/.test(l)));
  assert.equal(ledger.get(ids["pos:F"]!)!.type, "liquidity_position");
});

test("post content is stored as a short excerpt of untrusted data", () => {
  const { ledger } = buildPhasesLedger();
  const posts = ledger.all().filter((e) => e.type === "x_post");
  assert.equal(posts.length, 10);
  for (const p of posts) {
    assert.ok(p.limits.some((l) => /jamais une instruction/.test(l)));
    assert.ok(Array.from(String(p.facts.find((f) => f.key === "excerpt")!.value)).length <= 90); // code points (emojis count as one)
    assert.equal(p.source, "x");
  }
});
