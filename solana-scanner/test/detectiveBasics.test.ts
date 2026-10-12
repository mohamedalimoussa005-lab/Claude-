import { test } from "node:test";
import assert from "node:assert/strict";
import { Meter, budgeted, BudgetError } from "../src/detective/meter.ts";
import { MODES, parseMode, withMode } from "../src/detective/modes.ts";
import { base58Decode, findProgramAddress, utf8 } from "../src/detective/pda.ts";
import { classifyVenue, parsePools, resolveToken } from "../src/detective/resolve.ts";
import { buildSocial } from "../src/detective/social.ts";
import { renderMarkdown } from "../src/detective/render.ts";
import { DISCLAIMERS } from "../src/detective/types.ts";
import { PUMP_CANONICAL_CREATOR, PUMP_FEE_CONFIG, PUMP_GLOBAL_CONFIG } from "./fixtures/social/depth/raw.ts";
import { MINTS, dexPairs, fakeDex, fakeRpc } from "./helpers/detective.ts";

test("PDA derivation reproduces the Pump program addresses captured on-chain", () => {
  const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  assert.equal(findProgramAddress([utf8("global_config")], PUMP_AMM), PUMP_GLOBAL_CONFIG);
  assert.equal(findProgramAddress([utf8("fee_config"), base58Decode(PUMP_AMM)], "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"), PUMP_FEE_CONFIG);
  for (const k of ["A", "C"] as const) assert.equal(findProgramAddress([utf8("pool-authority"), base58Decode(MINTS[k])], "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), PUMP_CANONICAL_CREATOR[k]);
});

test("modes: three modes with growing budgets, parsed strictly and overridable", () => {
  assert.deepEqual(Object.keys(MODES), ["rapide", "standard", "profond"]);
  assert.ok(MODES.rapide.maxCalls < MODES.standard.maxCalls && MODES.standard.maxCalls < MODES.profond.maxCalls);
  assert.ok(MODES.profond.launch.cohortWallets <= 50 && MODES.profond.launch.hops <= 2, "the 5C limits are the ceiling");
  assert.equal(parseMode(undefined), "standard");
  assert.throws(() => parseMode("turbo"), /mode inconnu/);
  const m = withMode("rapide", { maxCalls: 10, launch: { earlyTransactions: 5 } });
  assert.equal(m.maxCalls, 10);
  assert.equal(m.launch.earlyTransactions, 5);
  assert.equal(m.launch.hops, MODES.rapide.launch.hops, "untouched fields keep the mode's value");
  assert.equal(MODES.rapide.maxCalls, 150, "overrides never mutate the defaults");
});

test("budget: calls are counted, the cap stops further reads, the limit is recorded", async () => {
  let t = 0;
  const meter = new Meter("rapide", 3, 60_000, () => t);
  const rpc = budgeted(fakeRpc(), meter);
  await rpc.getMultipleAccounts(["a"]);
  await rpc.getSignatures("a", 10);
  await rpc.call("getEpochInfo", []);
  await assert.rejects(() => rpc.getMultipleAccounts(["b"]), (e: unknown) => e instanceof BudgetError && e.kind === "calls");
  const r = meter.report();
  assert.equal(r.calls, 3);
  assert.deepEqual(Object.keys(r.byMethod).sort(), ["getEpochInfo", "getMultipleAccounts", "getSignaturesForAddress"]);
  assert.ok(r.limitsReached.some((l) => l.includes("budget d'appels RPC atteint (3)")));
});

test("budget: the time cap stops reads too", async () => {
  let t = 0;
  const meter = new Meter("rapide", 100, 1000, () => t);
  const rpc = budgeted(fakeRpc(), meter);
  await rpc.getBalanceLamports("a");
  t = 5000;
  await assert.rejects(() => rpc.getBalanceLamports("a"), (e: unknown) => e instanceof BudgetError && e.kind === "time");
  assert.ok(meter.report().limitsReached.some((l) => l.includes("temps")));
  assert.equal(meter.report().elapsedMs, 5000);
});

test("budget: the wrapper is read-only — no write or unknown RPC method can be called", async () => {
  const rpc = budgeted(fakeRpc(), new Meter("rapide", 10, 10_000));
  for (const m of ["sendTransaction", "simulateTransaction", "requestAirdrop", "getSlot"]) await assert.rejects(() => rpc.call(m, []), /non autorisée/);
  assert.equal("sendTransaction" in rpc, false);
});

test("budget: HTTP attempts and retries come from the client's log, null when not measured", () => {
  const m = new Meter("standard", 10, 1000);
  assert.equal(m.report().httpAttempts, null);
  m.onRequest({ method: "x", attempt: 1, durationMs: 1, outcome: "retry" });
  m.onRequest({ method: "x", attempt: 2, durationMs: 1, outcome: "ok" });
  m.onRequest({ method: "x", attempt: 0, durationMs: 0, outcome: "cache" });
  assert.deepEqual([m.report().httpAttempts, m.report().retries], [2, 1]);
});

test("DEX Screener parsing: pools of the token only, primary = most liquid, USD per quote from the pair's own numbers", async () => {
  const mint = MINTS.F;
  const pairs = [
    ...dexPairs("F"),
    { ...(dexPairs("F")[0] as object), pairAddress: "11111111111111111111111111111112", liquidity: { usd: 5 } },
    { chainId: "solana", pairAddress: "11111111111111111111111111111113", baseToken: { address: "other" }, quoteToken: { address: mint } },
    { chainId: "ethereum", pairAddress: "x", baseToken: { address: mint } },
  ];
  const r = await resolveToken(fakeDex({ [mint]: pairs }), mint);
  assert.equal(r.pools.length, 2);
  assert.equal(r.primary!.pairAddress, "57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P");
  assert.ok(Math.abs(r.primary!.usdPerQuote! - 1) < 0.01, "USDC ≈ 1 $");
  assert.ok(r.notes.some((n) => n.includes("2 pools")));
  assert.ok(r.notes.some((n) => n.includes("côté cotation")));
  assert.equal(r.profile.socials[0]!.type, "twitter");
});

test("DEX Screener: missing fields stay null, an empty answer is explained, an invalid address is rejected", async () => {
  const { pools } = parsePools([{ chainId: "solana", pairAddress: "11111111111111111111111111111112", baseToken: { address: MINTS.A } }], MINTS.A);
  assert.deepEqual([pools[0]!.priceUsd, pools[0]!.liquidityUsd, pools[0]!.usdPerQuote, pools[0]!.dexId], [null, null, null, null]);
  const none = await resolveToken(fakeDex({ [MINTS.A]: [] }), MINTS.A);
  assert.equal(none.primary, null);
  assert.ok(none.notes.some((n) => n.includes("aucun pool")));
  await assert.rejects(() => resolveToken(fakeDex({}), "not-an-address"), /adresse de token invalide/);
});

test("venue classification: the owner program decides; unsupported venues give their reason", () => {
  assert.deepEqual(classifyVenue("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "raydium"), { supported: true, kind: "clmm", program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", programName: "Raydium CLMM" });
  assert.equal((classifyVenue("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", null) as { kind: string }).kind, "cpmm");
  assert.equal((classifyVenue("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", null) as { kind: string }).kind, "pumpswap");
  const curve = classifyVenue("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pumpfun");
  assert.equal(curve.supported, false);
  assert.match((curve as { reason: string }).reason, /courbe de bonding pump\.fun avant migration/);
  for (const p of ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"]) assert.equal(classifyVenue(p, "x").supported, false);
  assert.match((classifyVenue("SomeUnknownProgram1111111111111111111111111", "x") as { reason: string }).reason, /programme du pool inconnu/);
  assert.match((classifyVenue(null, "raydium") as { reason: string }).reason, /introuvable/);
});

test("social: links are third-party declarations (INDICE); no link is INCONNU; no content is invented", async () => {
  const r = await resolveToken(fakeDex({ [MINTS.A]: dexPairs("A") }), MINTS.A);
  const s = buildSocial(r.profile, true);
  assert.equal(s.findings[0]!.level, "INDICE");
  assert.match(s.findings[0]!.text, /déclaration d'un tiers, non vérifiée/);
  assert.deepEqual(s.data!.domains, ["example.org", "x.com"]);
  assert.ok(s.unknowns.some((u) => u.includes("service payant")));
  const none = buildSocial({ websites: [], socials: [], imageUrl: null }, true);
  assert.equal(none.status, "unknown");
  assert.equal(none.findings[0]!.level, "INCONNU");
});

test("Markdown rendering carries the disclaimers, the legend and HYPOTHÈSE = désactivée", async () => {
  const { section } = await import("../src/detective/types.ts");
  const s = (t: string) => section(t);
  const md = renderMarkdown({
    schema: "detective-report/1", mint: MINTS.A, generatedAt: "2026-10-12T00:00:00Z", mode: "rapide", hypothesesEnabled: false, disclaimers: [...DISCLAIMERS],
    budget: { mode: "rapide", maxCalls: 150, maxMs: 1000, calls: 3, byMethod: { getTransaction: 3 }, httpAttempts: 4, retries: 1, elapsedMs: 2500, limitsReached: ["plafond"] },
    sections: { identity: s("Identité du token"), creator: s("Créateur"), firstBuyers: s("Premiers"), funding: s("Fin"), liquidity: s("Liq"), exitSimulations: s("Sim"), repetitive: s("Rep"), social: s("Soc"), evidence: s("Preuves"), synthesis: s("Synthèse") },
  });
  assert.match(md, /HYPOTHÈSE \| \*\*désactivée\*\*/);
  assert.match(md, /ne prédit ni le prix ni une fraude/);
  assert.match(md, /3 appel\(s\) RPC sur 150/);
  assert.match(md, /Limites atteintes : plafond/);
  assert.match(md, /## 1\. Identité du token/);
  assert.match(md, /Section INCONNUE/);
});
