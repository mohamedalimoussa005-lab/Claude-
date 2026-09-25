import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeOnchain } from "../src/onchain/analyze.ts";
import type { OnchainAnalysis } from "../src/onchain/analyze.ts";
import { base58Encode } from "../src/onchain/base58.ts";
import { findRelatedWallets } from "../src/onchain/clusters.ts";
import { collectOnchain, decodePumpBondingCurveCreator, findFunder } from "../src/onchain/collect.ts";
import type { OnchainRpc } from "../src/onchain/collect.ts";
import { ONCHAIN_CONFIG, PUMP_FUN_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from "../src/onchain/config.ts";
import { SolanaRpc, TtlCache } from "../src/onchain/rpc.ts";
import type { ParsedTransaction, RawAccount } from "../src/onchain/rpc.ts";
import { selectCandidates } from "../src/onchain/service.ts";
import type { HolderEntry, OnchainData, OwnerInfo, WalletHistory } from "../src/onchain/types.ts";
import { scorePair } from "../src/scoring/score.ts";
import type { NormalizedPair } from "../src/domain/normalize.ts";

/** Deterministic, valid-looking base58 address. */
const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const MINT = key(1);
const PAIR = key(2);
const CREATOR = key(3);
const cfg = ONCHAIN_CONFIG;

const wallet = (address: string): OwnerInfo => ({ address, exists: true, program: SYSTEM_PROGRAM, executable: false, lamports: 1e9 });
const holder = (owner: string, pct: number): HolderEntry => ({ owner, amountRaw: String(Math.round(pct * 1e13)), pctOfSupply: pct, tokenAccounts: 1 });

/** Spread-out distribution: 100 wallets from 3 % down, plus the pool at 8 %. */
function distribution(): { top: HolderEntry[]; owners: Record<string, OwnerInfo> } {
  const top = [holder(PAIR, 8), ...Array.from({ length: 29 }, (_, i) => holder(key(100 + i), 3 - i * 0.08))];
  const owners: Record<string, OwnerInfo> = {};
  for (const h of top) owners[h.owner] = h.owner === PAIR ? { address: PAIR, exists: true, program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", executable: false, lamports: 2e6 } : wallet(h.owner);
  return { top, owners };
}

function data(overrides: Partial<OnchainData> = {}): OnchainData {
  const { top, owners } = distribution();
  return {
    mintAddress: MINT,
    pairAddress: PAIR,
    dexId: "pumpswap",
    fetchedAt: 0,
    rpcUrl: "test",
    mintInfo: { status: "ok", value: { program: TOKEN_2022_PROGRAM, decimals: 6, supplyRaw: "1000000000000000", mintAuthority: null, freezeAuthority: null, extensions: [{ name: "tokenMetadata", state: {} }] } },
    holders: { status: "ok", value: { tokenAccounts: 2500, holderCount: 1800, top, pctByOwner: Object.fromEntries(top.map((t) => [t.owner, t.pctOfSupply])) } },
    owners: { status: "ok", value: owners },
    creator: { status: "ok", value: { address: CREATOR, method: "test", evidence: "test" } },
    creatorActivity: { status: "ok", value: { solBalance: 0.5, tokenPct: 0.1, recentSignatures: 5, analyzedTransactions: 5, events: [] } },
    wallets: {
      status: "ok",
      value: top.slice(1, 11).map((h, i): WalletHistory => ({
        address: h.owner,
        pct: h.pctOfSupply,
        signatureCount: 10,
        historyComplete: true,
        firstSeen: i * 3_600_000,
        funder: key(200 + i),
        fundingSignature: `fund${i}`,
        signatures: [`fund${i}`, `own${i}`],
      })),
    },
    ...overrides,
  };
}

const cat = (a: OnchainAnalysis, k: string) => a.categories.find((c) => c.key === k)!;
const withMint = (m: Partial<{ mintAuthority: string | null; freezeAuthority: string | null; extensions: { name: string; state: Record<string, unknown> }[] }>) => {
  const d = data();
  if (d.mintInfo.status === "ok") d.mintInfo = { status: "ok", value: { ...d.mintInfo.value, ...m } };
  return d;
};

// ─── authorities ─────────────────────────────────────────────────────────

test("authorities disabled: DISABLED, no authority risk, positive structural signals", () => {
  const a = analyzeOnchain(data());
  assert.equal(a.mintAuthority, "DISABLED");
  assert.equal(a.freezeAuthority, "DISABLED");
  assert.equal(cat(a, "authorities").points, 0);
  assert.ok(a.positives.some((p) => p.startsWith("Mint authority désactivée")));
  assert.ok(a.positives.some((p) => p.startsWith("Freeze authority désactivée")));
  assert.ok(!a.positives.some((p) => /safe/i.test(p)), "never says safe");
  assert.equal(a.confidence, "HIGH");
});

test("mint authority active: ACTIVE, risk up, precise explanation", () => {
  const a = analyzeOnchain(withMint({ mintAuthority: key(9) }));
  assert.equal(a.mintAuthority, "ACTIVE");
  assert.equal(a.mintAuthorityAddress, key(9));
  assert.equal(cat(a, "authorities").points, cfg.score.authorities.mintActive);
  assert.ok(a.redFlags.some((f) => f.includes("Mint authority ACTIVE") && f.includes(key(9)) && /créer de nouveaux tokens/.test(f)));
  assert.ok(a.risk > analyzeOnchain(data()).risk);
});

test("freeze authority active: ACTIVE, risk up, explanation mentions frozen accounts", () => {
  const a = analyzeOnchain(withMint({ freezeAuthority: key(8) }));
  assert.equal(a.freezeAuthority, "ACTIVE");
  assert.equal(cat(a, "authorities").points, cfg.score.authorities.freezeActive);
  assert.ok(a.redFlags.some((f) => f.includes("Freeze authority ACTIVE") && /geler/.test(f)));
});

test("risky Token-2022 extensions are flagged; authorities category is capped", () => {
  const a = analyzeOnchain(
    withMint({
      mintAuthority: key(9),
      freezeAuthority: key(8),
      extensions: [
        { name: "permanentDelegate", state: { delegate: key(7) } },
        { name: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 300 } } },
      ],
    }),
  );
  assert.equal(a.riskyExtensions.length, 2);
  assert.equal(cat(a, "authorities").points, cfg.score.authorities.max);
});

test("unknown mint data: UNKNOWN authorities, never treated as disabled", () => {
  const a = analyzeOnchain(data({ mintInfo: { status: "unavailable", error: "RPC down" } }));
  assert.equal(a.mintAuthority, "UNKNOWN");
  assert.equal(a.freezeAuthority, "UNKNOWN");
  assert.equal(cat(a, "authorities").points, cfg.score.authorities.unknownEach * 2);
  assert.ok(!a.positives.some((p) => p.includes("désactivée")));
  assert.ok(a.unknowns.some((u) => u.includes("Authorities")));
  assert.equal(a.confidence, "LOW");
  assert.ok(a.risk > analyzeOnchain(data()).risk, "missing data never improves the score");
});

// ─── holders ─────────────────────────────────────────────────────────────

test("a non-technical holder with 40 %: red flag and concentration risk", () => {
  const d = data();
  if (d.holders.status === "ok" && d.owners.status === "ok") {
    const big = key(50);
    d.holders.value.top = [holder(PAIR, 8), holder(big, 40), ...d.holders.value.top.slice(1, 29)];
    d.owners.value[big] = wallet(big);
  }
  const a = analyzeOnchain(d);
  assert.equal(a.holders!.largestNonTechnical!.owner, key(50));
  assert.ok(a.redFlags.some((f) => f.includes("détient") && f.includes("43.48 %")), a.redFlags.join("\n")); // 40 / 92 adjusted
  assert.ok(cat(a, "concentration").points >= 14);
});

test("very concentrated top 10: red flag and high concentration score", () => {
  const d = data();
  if (d.holders.status === "ok" && d.owners.status === "ok") {
    const whales = Array.from({ length: 10 }, (_, i) => holder(key(60 + i), 7));
    d.holders.value.top = [holder(PAIR, 8), ...whales, ...d.holders.value.top.slice(11)];
    for (const w of whales) d.owners.value[w.owner] = wallet(w.owner);
    d.holders.value.holderCount = 60;
  }
  const a = analyzeOnchain(d);
  assert.ok(a.holders!.adjusted!.top10 > 70);
  assert.ok(a.redFlags.some((f) => f.startsWith("Top 10 très concentré")));
  assert.ok(a.redFlags.some((f) => f.includes("Seulement 60 holders")));
  assert.ok(a.categories.find((c) => c.key === "concentration")!.items.some((i) => i.label === "Distribution extrêmement concentrée"));
  assert.ok(cat(a, "concentration").points >= 25, `concentration ${cat(a, "concentration").points}`);
});

test("LP identified among the largest accounts is excluded from adjusted concentration only", () => {
  const a = analyzeOnchain(data());
  const h = a.holders!;
  assert.equal(h.excluded.length, 1);
  assert.equal(h.excluded[0].owner, PAIR);
  assert.equal(h.excluded[0].class.kind, "pool");
  assert.equal(h.raw.top1, 8); // RAW keeps the pool
  assert.ok(Math.abs(h.adjusted!.top1 - 3 / 0.92) < 1e-9); // ADJUSTED: largest wallet over supply outside the pool
  assert.ok(a.positives.some((p) => p.includes("exclu")));
});

test("unverifiable program-owned holder is NOT excluded", () => {
  const d = data();
  const locker = key(70);
  if (d.holders.status === "ok" && d.owners.status === "ok") {
    d.holders.value.top = [holder(locker, 20), ...d.holders.value.top];
    d.owners.value[locker] = { address: locker, exists: true, program: key(71), executable: false, lamports: 1e6 };
  }
  const a = analyzeOnchain(d);
  assert.ok(!a.holders!.excluded.some((e) => e.owner === locker));
  assert.equal(a.holders!.largestNonTechnical!.owner, locker);
  assert.ok(a.unknowns.some((u) => u.includes("usage non vérifiable")));
});

test("missing holder data: UNKNOWN concentration with explicit risk points, LOW confidence", () => {
  const a = analyzeOnchain(data({ holders: { status: "unavailable", error: "429" }, owners: { status: "unavailable", error: "dépend" }, wallets: { status: "unavailable", error: "dépend" } }));
  assert.equal(a.holders, null);
  assert.equal(cat(a, "concentration").points, cfg.score.concentration.unknown);
  assert.ok(a.unknowns.some((u) => u.startsWith("Distribution des holders non vérifiée")));
  assert.equal(a.confidence, "LOW");
  assert.ok(a.risk > analyzeOnchain(data()).risk);
});

test("owners not classified: RAW used, adjusted marked impossible", () => {
  const a = analyzeOnchain(data({ owners: { status: "unavailable", error: "timeout" } }));
  assert.equal(a.holders!.adjusted, null);
  assert.ok(a.unknowns.some((u) => u.includes("concentration brute utilisée")));
});

// ─── creator ─────────────────────────────────────────────────────────────

test("unknown creator: 'non identifié', risk points, never invents an address", () => {
  const a = analyzeOnchain(data({ creator: { status: "not_found", reason: "création hors de portée" }, creatorActivity: { status: "not_found", reason: "deployment-associated wallet non identifié" } }));
  assert.equal(a.creator, null);
  assert.match(a.creatorNote, /non identifié/);
  assert.equal(cat(a, "creator").points, cfg.score.creator.unknown);
  assert.ok(a.risk > analyzeOnchain(data()).risk);
});

test("creator wording is 'deployment-associated wallet', sells and multi-wallet transfers are flagged", () => {
  const a = analyzeOnchain(
    data({
      creatorActivity: {
        status: "ok",
        value: {
          solBalance: 3,
          tokenPct: 6,
          recentSignatures: 5,
          analyzedTransactions: 5,
          events: [
            { signature: "s1", time: 0, kind: "sell", tokenDeltaPct: -2.5, recipients: [] },
            { signature: "s2", time: 0, kind: "transfer", tokenDeltaPct: -1, recipients: [key(80), key(81), key(82)] },
          ],
        },
      },
    }),
  );
  assert.match(a.creatorNote, /Deployment-associated wallet/);
  assert.match(a.creatorNote, /pas une preuve/);
  assert.ok(a.redFlags.some((f) => f.includes("détient encore 6.00 %")));
  assert.ok(a.redFlags.some((f) => f.includes("a vendu 2.50 %")));
  assert.ok(a.redFlags.some((f) => f.includes("vers 3 wallets")));
});

// ─── wallet relationships ────────────────────────────────────────────────

test("potentially related wallets: same funding tx and direct funding form a group", () => {
  const w = (address: string, pct: number, extra: Partial<WalletHistory>): WalletHistory => ({
    address, pct, signatureCount: 3, historyComplete: true, firstSeen: 0, funder: null, fundingSignature: null, signatures: [], ...extra,
  });
  const A = key(90), B = key(91), C = key(92), D = key(93);
  const r = findRelatedWallets(
    [
      w(A, 4, { funder: key(99), fundingSignature: "same", signatures: ["same"], firstSeen: 0 }),
      w(B, 3, { funder: key(99), fundingSignature: "same", signatures: ["same"], firstSeen: 60_000 }),
      w(C, 2, { funder: A, fundingSignature: "other", signatures: ["other"], firstSeen: 10 * 86_400_000 }),
      w(D, 1, { funder: key(98), fundingSignature: "d", signatures: ["d"], firstSeen: 30 * 86_400_000 }),
    ],
    10,
  );
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].members.map((m) => m.address).sort(), [A, B, C].sort());
  assert.equal(r.groups[0].share, 9);
  assert.ok(r.groups[0].reasons.some((x) => x === "2 wallets financés dans la même transaction"));
  assert.ok(r.groups[0].reasons.some((x) => x.includes("financé par")));
  assert.ok(r.strongLinks >= 2);

  const d = data();
  if (d.wallets.status === "ok") {
    d.wallets.value[0] = { ...d.wallets.value[0], funder: key(99), fundingSignature: "same" };
    d.wallets.value[1] = { ...d.wallets.value[1], funder: key(99), fundingSignature: "same", signatures: ["same"] };
  }
  const a = analyzeOnchain(d);
  const flag = a.redFlags.find((f) => f.startsWith("Potentially related wallets"));
  assert.ok(flag);
  assert.match(flag, /Heuristique, pas une preuve/);
  assert.ok(!a.redFlags.some((f) => /same owner|même propriétaire/i.test(f)));
  assert.ok(cat(a, "relationships").points > 0);
});

test("same funder: close in time = strong, busy funder at different times = weak and not grouped", () => {
  const w = (address: string, firstSeen: number, count: number | null): WalletHistory => ({
    address, pct: 3, signatureCount: 2, historyComplete: true, firstSeen, funder: key(99), fundingSignature: address, funderSignatureCount: count, signatures: [address],
  });
  const close = findRelatedWallets([w(key(84), 0, 1000), w(key(85), 60_000, 1000)], { closeCreationMinutes: 10, busyFunderSignatures: 1000 });
  assert.equal(close.links[0].type, "sameFunderClose");
  assert.equal(close.links[0].strength, "strong");
  assert.equal(close.groups.length, 1);
  assert.match(close.groups[0].reasons[0], /2 wallets financés par .* à moins de 10 min/);

  const busy = findRelatedWallets([w(key(86), 0, 1000), w(key(87), 86_400_000, 1000)], { closeCreationMinutes: 10, busyFunderSignatures: 1000 });
  assert.equal(busy.links[0].type, "sameBusyFunder");
  assert.equal(busy.links[0].strength, "weak");
  assert.equal(busy.groups.length, 0);
});

test("a shared exchange-like funder is only a medium link, with a caveat", () => {
  const w = (address: string): WalletHistory => ({ address, pct: 2, signatureCount: 2, historyComplete: true, firstSeen: null, funder: key(99), fundingSignature: address, signatures: [address] });
  const r = findRelatedWallets([w(key(94)), w(key(95))], 10);
  assert.equal(r.links[0].strength, "medium");
  assert.match(r.links[0].reason, /peut être un exchange/);
});

// ─── collection with a fake RPC ──────────────────────────────────────────

function tokenAccount(owner: string, amount: bigint): string {
  const bytes = new Uint8Array(40);
  const ownerBytes = new Uint8Array(32).fill(Number(owner.split("|")[1] ?? 0));
  bytes.set(ownerBytes, 0);
  new DataView(bytes.buffer).setBigUint64(32, amount, true);
  return Buffer.from(bytes).toString("base64");
}

function fakeRpc(overrides: Partial<OnchainRpc> = {}): OnchainRpc {
  const curve = key(10);
  const curveData = new Uint8Array(151);
  curveData.set(new Uint8Array(32).fill(3), 49); // creator = key(3)
  const accounts: Record<string, RawAccount> = {
    [curve]: { owner: PUMP_FUN_PROGRAM, lamports: 1e6, executable: false, data: [Buffer.from(curveData).toString("base64"), "base64"] },
  };
  return {
    url: "fake",
    getParsedAccount: async () => ({ owner: TOKEN_2022_PROGRAM, data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000000", mintAuthority: null, freezeAuthority: key(8), extensions: [] } } } }),
    getTokenAccountsForMint: async () => [
      { pubkey: "a1", data: tokenAccount("|10", 700_000n) },
      { pubkey: "a2", data: tokenAccount("|20", 200_000n) },
      { pubkey: "a3", data: tokenAccount("|21", 100_000n) },
      { pubkey: "a4", data: tokenAccount("|22", 0n) },
    ],
    getMultipleAccounts: async (addrs: string[]) => addrs.map((a) => accounts[a] ?? { owner: SYSTEM_PROGRAM, lamports: 1e9, executable: false, data: ["", "base64"] }),
    getSignatures: async () => [],
    getTransaction: async () => null,
    getBalanceLamports: async () => 2e9,
    ...overrides,
  } as OnchainRpc;
}

test("collect: bonding curve identified among holders, creator decoded, freeze authority read", async () => {
  const d = await collectOnchain(fakeRpc(), { mint: MINT, pairAddress: null, dexId: "pumpfun" });
  assert.equal(d.holders.status, "ok");
  if (d.holders.status !== "ok") return;
  assert.equal(d.holders.value.holderCount, 3);
  assert.equal(d.holders.value.tokenAccounts, 4);
  assert.equal(d.holders.value.top[0].pctOfSupply, 70);
  assert.equal(d.creator.status, "ok");
  if (d.creator.status === "ok") assert.equal(d.creator.value.address, CREATOR);
  const a = analyzeOnchain(d);
  assert.equal(a.freezeAuthority, "ACTIVE");
  assert.equal(a.holders!.excluded[0].class.kind, "bondingCurve");
  assert.equal(a.holders!.raw.top1, 70);
  assert.ok(Math.abs(a.holders!.adjusted!.top1 - 200 / 3) < 0.01); // 20 % of the 30 % outside the curve
});

test("collect: RPC unavailable → every section unavailable, UNKNOWN everywhere, LOW confidence, no crash", async () => {
  const down = async () => {
    throw new Error("RPC network error: fetch failed");
  };
  const rpc = fakeRpc({ getParsedAccount: down, getTokenAccountsForMint: down, getMultipleAccounts: down, getSignatures: down, getTransaction: down, getBalanceLamports: down });
  const d = await collectOnchain(rpc, { mint: MINT, pairAddress: PAIR, dexId: "pumpswap" });
  assert.equal(d.mintInfo.status, "unavailable");
  assert.equal(d.holders.status, "unavailable");
  assert.equal(d.creator.status, "unavailable");
  const a = analyzeOnchain(d);
  assert.equal(a.mintAuthority, "UNKNOWN");
  assert.equal(a.freezeAuthority, "UNKNOWN");
  assert.equal(a.holders, null);
  assert.equal(a.confidence, "LOW");
  assert.equal(a.positives.length, 0, "nothing positive is inferred from missing data");
  assert.ok(a.unknowns.length >= 3);
  assert.ok(a.risk >= 50, `risk ${a.risk}`);
});

test("decoders and funder detection", () => {
  const d = new Uint8Array(151);
  assert.equal(decodePumpBondingCurveCreator(Buffer.from(d).toString("base64")), null, "zero creator is not an address");
  d.set(new Uint8Array(32).fill(3), 49);
  assert.equal(decodePumpBondingCurveCreator(Buffer.from(d).toString("base64")), CREATOR);

  const W = key(40), F = key(41), P = key(42);
  const tx: ParsedTransaction = {
    blockTime: 1,
    transaction: { signatures: ["x"], message: { accountKeys: [{ pubkey: P, signer: true, writable: true }, { pubkey: F, signer: true, writable: true }, { pubkey: W, signer: false, writable: true }], instructions: [] } },
    meta: { err: null, fee: 5000, preBalances: [1e9, 5e9, 0], postBalances: [1e9 - 5000, 3e9, 2e9] },
  };
  assert.equal(findFunder(tx, W, 0.01), F);
});

// ─── RPC client & selection ──────────────────────────────────────────────

test("RPC client retries a 429, then caches the result", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } }), { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 42 } }), { status: 200 });
  }) as typeof fetch;
  const rpc = new SolanaRpc({ fetchImpl, sleep: async () => {}, cache: new TtlCache() });
  assert.equal(await rpc.getBalanceLamports(key(1)), 42);
  assert.equal(await rpc.getBalanceLamports(key(1)), 42);
  assert.equal(calls, 2);
});

test("RPC client surfaces a JSON-RPC error without retrying", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } }), { status: 200 });
  }) as typeof fetch;
  const rpc = new SolanaRpc({ fetchImpl, sleep: async () => {} });
  await assert.rejects(rpc.getBalanceLamports(key(1)), /Invalid param/);
  assert.equal(calls, 1);
});

test("on-chain analysis only runs on selected candidates", () => {
  const base = (i: number, o: Partial<NormalizedPair>): NormalizedPair => ({
    chainId: "solana", dexId: "raydium", url: null, pairAddress: `P${i}`, tokenAddress: `T${i}`, tokenName: null, tokenSymbol: null, quoteSymbol: null,
    priceUsd: 1, marketCap: 400_000, fdv: 400_000, liquidityUsd: 80_000, volumeM5: 15_000, volumeH1: 190_000, volumeH6: 700_000, volumeH24: 1_500_000,
    buysM5: 90, sellsM5: 70, buysH1: 1_000, sellsH1: 900, priceChangeM5: 2, priceChangeH1: 12, priceChangeH6: 30, pairCreatedAt: Date.now() - 8 * 3_600_000, ...o,
  });
  const rows = [
    base(1, {}),
    base(2, { priceChangeH1: -95, priceChangeH6: -95 }), // high DEX risk
    base(3, { volumeH1: 100, volumeM5: 10, buysH1: 5, sellsH1: 1, buysM5: 1, sellsM5: 0 }), // weak opportunity
    base(4, { priceChangeH1: 20 }),
  ].map((pair) => ({ pair, score: scorePair(pair) }));
  const picked = selectCandidates(rows, { ...cfg, candidates: { ...cfg.candidates, max: 5 } }).map((r) => r.pair.tokenAddress);
  assert.deepEqual(picked.sort(), ["T1", "T4"]);
});
