import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessToken, formatAssessment } from "../src/final/assessment.ts";
import type { FinalAssessment } from "../src/final/assessment.ts";
import { analyzeOnchain } from "../src/onchain/analyze.ts";
import { base58Encode } from "../src/onchain/base58.ts";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from "../src/onchain/config.ts";
import type { HolderEntry, OnchainData, OwnerInfo, WalletHistory } from "../src/onchain/types.ts";
import type { Label, PairScore } from "../src/scoring/score.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer, WalletIntel } from "../src/wallets/intel.ts";
import { unknownWalletFacts } from "../src/wallets/resilience.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";

/**
 * Final Decision Engine V1: rules over confirmed facts of the existing engines.
 * Fixtures only (real analyzeOnchain / buildIntel / profileWallet), no data call.
 */

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const MINT = key(1);
const PAIR = key(2);
const CREATOR = key(3);
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;

// ─── DEX (Step 2) result: only the fields the engine reads, the label as computed by Step 2 ─

const score = (label: Label | null, o: Partial<PairScore> = {}): PairScore =>
  ({
    label,
    labelReason: `fixture ${label ?? "sans label"}`,
    opportunity: 72,
    risk: label === "HIGH RISK" ? 55 : 12,
    quality: 70,
    confidence: { level: "HIGH" },
    signals: { positive: ["Pression acheteuse 1 h : 68 % d'achats"], negative: [], anomalies: [] },
    missingFields: [],
    riskFactors: [],
    ...o,
  }) as unknown as PairScore;

// ─── On-chain (Step 3) data → real analyzeOnchain ───────────────────────

const owner = (address: string): OwnerInfo => ({ address, exists: true, program: SYSTEM_PROGRAM, executable: false, lamports: 1e9 });
const holder = (o: string, pct: number): HolderEntry => ({ owner: o, amountRaw: String(Math.round(pct * 1e13)), pctOfSupply: pct, tokenAccounts: 1 });
const H = (i: number) => key(100 + i);

function data(o: { top?: HolderEntry[]; mapWallets?: (w: WalletHistory, i: number) => WalletHistory; mint?: Record<string, unknown> } & Partial<OnchainData> = {}): OnchainData {
  const top = o.top ?? [holder(PAIR, 8), ...Array.from({ length: 29 }, (_, i) => holder(H(i), 3 - i * 0.08))];
  const owners: Record<string, OwnerInfo> = {};
  for (const h of top) owners[h.owner] = h.owner === PAIR ? { address: PAIR, exists: true, program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", executable: false, lamports: 2e6 } : owner(h.owner);
  const base: OnchainData = {
    mintAddress: MINT,
    pairAddress: PAIR,
    dexId: "pumpswap",
    fetchedAt: 0,
    rpcUrl: "test",
    mintInfo: { status: "ok", value: { program: TOKEN_2022_PROGRAM, decimals: 6, supplyRaw: "1000000000000000", mintAuthority: null, freezeAuthority: null, extensions: [{ name: "tokenMetadata", state: {} }], ...o.mint } },
    holders: { status: "ok", value: { tokenAccounts: 2500, holderCount: 1800, top, pctByOwner: Object.fromEntries(top.map((t) => [t.owner, t.pctOfSupply])) } },
    owners: { status: "ok", value: owners },
    creator: { status: "ok", value: { address: CREATOR, method: "test", evidence: "test" } },
    creatorActivity: { status: "ok", value: { solBalance: 0.5, tokenPct: 0.1, recentSignatures: 5, analyzedTransactions: 5, events: [] } },
    wallets: {
      status: "ok",
      value: top.slice(1, 11).map((h, i): WalletHistory => {
        const w: WalletHistory = { address: h.owner, pct: h.pctOfSupply, signatureCount: 10, historyComplete: true, firstSeen: i * 3_600_000, funder: key(200 + i), fundingSignature: `fund${i}`, signatures: [`fund${i}`, `own${i}`] };
        return o.mapWallets ? o.mapWallets(w, i) : w;
      }),
    },
  };
  const { top: _t, mapWallets: _w, mint: _m, ...rest } = o;
  return { ...base, ...rest };
}
const onchain = (d: OnchainData = data()) => ({ data: d, analysis: analyzeOnchain(d) });

// ─── Wallet Intelligence (Step 4) → real buildIntel / profileWallet ─────

const trade = (o: string, mint: string, side: "buy" | "sell", sol: number, t: number): Trade => ({ signature: `${o}-${mint}-${side}-${t}`, slot: null, time: t, owner: o, mint, side, tokenAmount: 1000, sol });
const closed = (n: number, o: string, sell: (i: number) => number = (i) => (i % 3 === 0 ? 0.8 : 1.6)) =>
  Array.from({ length: n }, (_, i) => [trade(o, key(150 + i), "buy", 1, min(-3000 + i * 60)), trade(o, key(150 + i), "sell", sell(i), min(-3000 + i * 60 + 30))]).flat();
const quietBot = { sampleSize: 60, spanMinutes: 20, txPerMinute: 0.1, trades: 4, distinctTokens: 4, roundTrips: 0, fastRoundTrips: 0, identicalAmountRoundTrips: 0, medianHoldSeconds: null, averageTicketSol: 1, highFrequency: false, fastFlipper: false, manyTokens: false, microTickets: false, botLike: false, evidence: [] as string[] };
const history = (incomplete = false): any => ({
  mode: "quick",
  completeness: incomplete ? "incomplete" : "recent_page_covers_history",
  signatureCountIsLowerBound: incomplete,
  origin: { found: true, firstSeen: null, signature: "old", method: "recent_page", complete: !incomplete, reason: "found", signaturesScanned: 0, totalSignatures: null },
  bot: quietBot,
  transfers: [],
  quickCompletion: incomplete ? { attempted: false, skippedReason: "history_too_long", stopReason: null, pages: 0 } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null, pages: 0 },
  deep: incomplete ? { attempted: false, skippedReason: "deep_disabled", stopReason: null } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null },
  providerTrace: [],
  unknowns: [],
});
let fid = 0;
const wf = (address: string, o: Partial<WalletFacts> = {}): WalletFacts => ({
  address, signatureCount: 2000, historyComplete: true, firstSeen: min(-43200), funder: key(220 + (fid++ % 30)), fundingSignature: `wf-${address}`, fundingTime: min(-43200),
  funderSignatureCount: null, signatures: [], trades: closed(30, address), historyNote: "complet", undecodableTxs: 0, history: history(), ...o,
});
const incompleteWallet = (address: string, o: Partial<WalletFacts> = {}) => wf(address, { signatureCount: 1000, historyComplete: false, trades: null, historyNote: "historique partiel", history: history(true), ...o });
const scan: TokenScan = { mint: MINT, launch: { time: min(0), slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: min(10 + i), owner: a, mint: MINT, side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 10 + i, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });
const intel = (fs: WalletFacts[], creatorFunding: Parameters<typeof buildIntel>[3]["creatorFunding"] = null): WalletIntel =>
  buildIntel(scan, fs.map((f, i) => buyer(f.address, i)), fs, { creator: CREATOR, creatorFunder: null, creatorFunding, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: min(600) });
const W = (i: number) => key(60 + i);
const goodWallets = () => intel([wf(W(0)), wf(W(1))]);

const facts = (a: FinalAssessment) => (k: keyof Pick<FinalAssessment, "positives" | "negatives" | "uncertainties" | "informational">) => a[k].map((r) => r.fact);
const has = (a: FinalAssessment, k: "positives" | "negatives" | "uncertainties" | "informational", prefix: string) => a[k].some((r) => r.fact.startsWith(prefix));

// ─── A–Q ─────────────────────────────────────────────────────────────────

test("A: DEX MOMENTUM, no structural warning, good wallets → MOMENTUM with wallet confirmation", () => {
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(), wallets: goodWallets() });
  assert.equal(a.decision, "MOMENTUM");
  assert.deepEqual([a.blockers, a.cautions], [[], []]);
  assert.ok(has(a, "positives", "wallets:highQuality"));
  assert.ok(has(a, "positives", "dex:+"));
  assert.deepEqual(a.dataConfidence.wallets, { HIGH: 2, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
});

test("B: DEX MOMENTUM + freeze authority ACTIVE (confirmed) → AVOID", () => {
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(data({ mint: { freezeAuthority: key(8) } })), wallets: goodWallets() });
  assert.equal(a.decision, "AVOID");
  assert.deepEqual(a.blockers.map((b) => b.fact), ["onchain:freezeAuthority"]);
  assert.ok(a.why.some((l) => l.startsWith("WHY CHANGED: hard blocker confirmé")));
});

test("C: DEX WATCH + mint authority ACTIVE → CAUTION", () => {
  const a = assessToken({ score: score("WATCH"), onchain: onchain(data({ mint: { mintAuthority: key(9) } })) });
  assert.equal(a.decision, "CAUTION");
  assert.deepEqual(a.cautions.map((c) => c.fact), ["onchain:mintAuthority"]);
  assert.equal(a.baseDecision, "WATCH");
});

test("D: DEX MOMENTUM + Quality UNKNOWN + Data Confidence UNKNOWN → MOMENTUM with uncertainty, no negative", () => {
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(), wallets: intel([incompleteWallet(W(0)), incompleteWallet(W(1))]) });
  assert.equal(a.decision, "MOMENTUM");
  assert.ok(has(a, "uncertainties", "wallets:qualityUnknown"));
  assert.ok(has(a, "uncertainties", "wallets:dataConfidence"));
  assert.ok(!a.negatives.some((r) => r.sources.includes("wallet_intel")), "UNKNOWN never negative");
  assert.deepEqual(a.dataConfidence.wallets, { HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 2 });
});

test("E: DEX MOMENTUM + measured low-quality wallets, no structural caution → MOMENTUM with warning", () => {
  const losers = intel([wf(W(0), { trades: closed(12, W(0), () => 0.3) }), wf(W(1), { trades: closed(12, W(1), () => 0.3) })]);
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(), wallets: losers });
  assert.equal(a.decision, "MOMENTUM");
  const r = a.negatives.find((x) => x.fact === "wallets:belowThreshold")!;
  assert.ok(r.text.includes("pas un signe de scam"));
  assert.equal(r.severity, "low");
});

test("F: DEX WATCH + several strong sharedTx, no caution gate → WATCH with relation warning", () => {
  const d = data({ mapWallets: (w, i) => (i < 4 ? { ...w, signatures: [...w.signatures, "bundle"] } : w) });
  const a = assessToken({ score: score("WATCH"), onchain: onchain(d) });
  assert.equal(a.decision, "WATCH");
  const rel = a.negatives.filter((r) => r.fact.startsWith("relation:sharedTx"));
  assert.equal(rel.length, 6, "4 wallets → 6 pairs, one reason each");
  assert.ok(rel.every((r) => r.severity === "high"));
  assert.ok(!a.negatives.some((r) => r.fact === "onchain:relatedGroup"), "group red flag replaced by canonical relations");
});

test("G: DEX MOMENTUM + sameBusyFunder only → MOMENTUM, informational only", () => {
  const d = data({ mapWallets: (w, i) => (i < 2 ? { ...w, funder: key(240), fundingSignature: `f${i}`, funderSignatureCount: 5000 } : w) });
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(d) });
  assert.equal(a.decision, "MOMENTUM");
  assert.ok(has(a, "informational", "relation:sameBusyFunder"));
  assert.ok(!a.negatives.some((r) => r.fact.startsWith("relation:")));
  assert.ok(!a.uncertainties.some((r) => r.fact.startsWith("relation:")));
});

test("H: DEX MOMENTUM + sameFunderUnknownActivity only → MOMENTUM with uncertainty", () => {
  const d = data({ mapWallets: (w, i) => (i < 2 ? { ...w, funder: key(240), fundingSignature: `f${i}` } : w) });
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(d) });
  assert.equal(a.decision, "MOMENTUM");
  assert.ok(has(a, "uncertainties", "relation:sameFunderUnknownActivity"));
  assert.ok(!a.negatives.some((r) => r.fact.startsWith("relation:")), "unknown activity never presumed rare");
});

test("I: DEX MOMENTUM + wallet funded by the deployment wallet → MOMENTUM with a strong negative, not a gate", () => {
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(), wallets: intel([wf(W(0), { funder: CREATOR }), wf(W(1))]) });
  assert.equal(a.decision, "MOMENTUM");
  const r = a.negatives.find((x) => x.fact.startsWith("creator:fundedByCreator"))!;
  assert.equal(r.severity, "high");
  assert.deepEqual([a.blockers, a.cautions], [[], []]);
});

test("J: DEX MOMENTUM + many wallets UNKNOWN → MOMENTUM with uncertainty", () => {
  const ws = [wf(W(0)), ...Array.from({ length: 6 }, (_, i) => incompleteWallet(W(1 + i))), unknownWalletFacts(W(9), "history", "timeout", false)];
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(), wallets: intel(ws) });
  assert.equal(a.decision, "MOMENTUM");
  const u = a.uncertainties.find((r) => r.fact === "wallets:qualityUnknown")!;
  assert.ok(u.text.startsWith("7/8 wallet(s)") && u.text.includes("history_incomplete 6") && u.text.includes("provider_failure 1"));
});

test("K: NO SIGNAL + excellent wallets → NO SIGNAL (wallets never create interest)", () => {
  const a = assessToken({ score: score(null), onchain: onchain(), wallets: goodWallets() });
  assert.equal(a.decision, "NO SIGNAL");
  assert.ok(has(a, "positives", "wallets:highQuality"));
});

test("L: the same sharedTx seen by Step 3 and Step 4 → one canonical reason with both sources", () => {
  const d = data({ mapWallets: (w, i) => (i < 2 ? { ...w, signatures: [...w.signatures, "bundle"] } : w) });
  const ws = intel([wf(H(0), { signatures: ["bundle"] }), wf(H(1), { signatures: ["bundle"] })]);
  assert.ok(ws.related.links.some((l) => l.type === "sharedTx"));
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(d), wallets: ws });
  const rel = a.negatives.filter((r) => r.fact.startsWith("relation:sharedTx"));
  assert.equal(rel.length, 1);
  assert.deepEqual(rel[0].sources, ["onchain", "wallet_intel"]);
  assert.ok(formatAssessment(a).includes("[onchain + wallet_intel]"));
});

test("L': different evidence is never merged (other pair in Step 4)", () => {
  const d = data({ mapWallets: (w, i) => (i < 2 ? { ...w, signatures: [...w.signatures, "bundle"] } : w) });
  const ws = intel([wf(W(0), { signatures: ["other"] }), wf(W(1), { signatures: ["other"] })]);
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(d), wallets: ws });
  const rel = a.negatives.filter((r) => r.fact.startsWith("relation:sharedTx"));
  assert.equal(rel.length, 2);
  assert.deepEqual(rel.map((r) => r.sources), [["onchain"], ["wallet_intel"]]);
});

test("M: NO SIGNAL + freeze authority ACTIVE → AVOID", () => {
  const a = assessToken({ score: score(null), onchain: onchain(data({ mint: { freezeAuthority: key(8) } })) });
  assert.equal(a.decision, "AVOID");
});

test("N: DEX HIGH RISK without hard blocker → CAUTION; with one → AVOID", () => {
  assert.equal(assessToken({ score: score("HIGH RISK"), onchain: onchain() }).decision, "CAUTION");
  assert.equal(assessToken({ score: score("HIGH RISK") }).decision, "CAUTION");
  assert.equal(assessToken({ score: score("HIGH RISK"), onchain: onchain(data({ mint: { freezeAuthority: key(8) } })) }).decision, "AVOID");
});

test("O: DEX MOMENTUM + holders UNKNOWN → MOMENTUM with uncertainty, never CAUTION from the UNKNOWN-inflated Risk", () => {
  const clean = onchain();
  const d = data({ holders: { status: "unavailable", error: "RPC down" } });
  const res = onchain(d);
  assert.ok(res.analysis.risk > clean.analysis.risk, "the raw Risk rises with UNKNOWN data");
  const a = assessToken({ score: score("MOMENTUM"), onchain: res });
  assert.equal(a.decision, "MOMENTUM");
  assert.ok(a.uncertainties.some((r) => r.text.includes("Distribution des holders non vérifiée")));
  assert.ok(!a.negatives.some((r) => r.sources.includes("onchain")));
});

test("P: DEX MOMENTUM + top 10 ≥ 70 % confirmed (adjusted basis) → CAUTION", () => {
  const top = [holder(PAIR, 8), ...Array.from({ length: 10 }, (_, i) => holder(H(i), 7)), ...Array.from({ length: 19 }, (_, i) => holder(H(10 + i), 0.5))];
  const res = onchain(data({ top }));
  assert.ok(res.analysis.holders!.adjusted!.top10 >= 75);
  const a = assessToken({ score: score("MOMENTUM"), onchain: res });
  assert.equal(a.decision, "CAUTION");
  assert.deepEqual(a.cautions.map((c) => c.fact), ["onchain:extremeConcentration"]);
});

test("P': the same concentration on the raw basis only (owners unavailable) is an uncertainty, not a caution", () => {
  const top = [holder(PAIR, 8), ...Array.from({ length: 10 }, (_, i) => holder(H(i), 7)), ...Array.from({ length: 19 }, (_, i) => holder(H(10 + i), 0.5))];
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(data({ top, owners: { status: "unavailable", error: "x" } })) });
  assert.equal(a.decision, "MOMENTUM");
  assert.ok(has(a, "uncertainties", "onchain:extremeConcentration:raw"));
});

test("Q: DEX MOMENTUM + transfer fee only → MOMENTUM with warning, no gate", () => {
  const ext = [{ name: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 300 } } }];
  const a = assessToken({ score: score("MOMENTUM"), onchain: onchain(data({ mint: { extensions: ext } })) });
  assert.equal(a.decision, "MOMENTUM");
  const r = a.negatives.find((x) => x.fact === "onchain:extension:transferFeeConfig")!;
  assert.ok(r.text.includes("3.00 %"));
  assert.deepEqual([a.blockers, a.cautions], [[], []]);
});

// ─── other gates ─────────────────────────────────────────────────────────

test("hard blockers: Token-2022 nonTransferable / defaultAccountState frozen / permanentDelegate → AVOID; transferHook → CAUTION", () => {
  const one = (name: string, state: Record<string, unknown>) => assessToken({ score: score("MOMENTUM"), onchain: onchain(data({ mint: { extensions: [{ name, state }] } })) });
  assert.equal(one("nonTransferable", {}).decision, "AVOID");
  assert.equal(one("defaultAccountState", { accountState: "frozen" }).decision, "AVOID");
  assert.equal(one("defaultAccountState", { accountState: "initialized" }).decision, "MOMENTUM");
  assert.equal(one("permanentDelegate", { delegate: key(9) }).decision, "AVOID");
  assert.equal(one("permanentDelegate", { delegate: null }).decision, "MOMENTUM", "no delegate set: not active");
  assert.equal(one("transferHook", { programId: key(9) }).decision, "CAUTION");
});

test("deployment wallet holding ≥ 5 % or selling / transferring (existing red flags) → CAUTION", () => {
  const act = (v: Record<string, unknown>) => ({ status: "ok" as const, value: { solBalance: 0.5, tokenPct: 0.1, recentSignatures: 5, analyzedTransactions: 5, events: [], ...v } });
  const run = (v: Record<string, unknown>) => assessToken({ score: score("WATCH"), onchain: onchain(data({ creatorActivity: act(v) as any })) });
  assert.deepEqual(run({ tokenPct: 6 }).cautions.map((c) => c.fact), ["onchain:creatorHolding"]);
  assert.equal(run({ tokenPct: 4.9 }).decision, "WATCH");
  assert.deepEqual(run({ events: [{ signature: "s", time: 1, kind: "sell", tokenDeltaPct: -2, recipients: [] }] }).cautions.map((c) => c.fact), ["onchain:creatorSold"]);
  const tr = run({ events: [{ signature: "t", time: 1, kind: "transfer", tokenDeltaPct: -2, recipients: [key(70), key(71)] }] });
  assert.ok(tr.cautions.some((c) => c.fact === "onchain:creatorTransfers"));
});

test("NO SIGNAL + structural caution stays NO SIGNAL (with the warning)", () => {
  const a = assessToken({ score: score(null), onchain: onchain(data({ mint: { mintAuthority: key(9) } })) });
  assert.equal(a.decision, "NO SIGNAL");
  assert.ok(has(a, "negatives", "onchain:mintAuthority"));
  assert.ok(a.why.some((l) => l.includes("NO SIGNAL reste NO SIGNAL")));
});

// ─── UNKNOWN handling ────────────────────────────────────────────────────

test("UNKNOWN never negative: every on-chain section unavailable → high raw Risk, no gate, no on-chain negative", () => {
  const down = { status: "unavailable" as const, error: "RPC down" };
  const res = onchain(data({ mintInfo: down, holders: down, owners: down, creator: down, creatorActivity: down, wallets: down }));
  assert.ok(res.analysis.risk >= 40, `raw Risk ${res.analysis.risk}`);
  for (const label of ["MOMENTUM", "WATCH", null] as const) {
    const a = assessToken({ score: score(label), onchain: res });
    assert.equal(a.decision, label === null ? "NO SIGNAL" : label);
    assert.ok(!a.negatives.some((r) => r.sources.includes("onchain")));
    assert.ok(a.uncertainties.length >= 5);
  }
  // Missing DEX fields are uncertainty too.
  const s = score("WATCH", { missingFields: ["liquidity.usd"], signals: { positive: [], negative: ["Données absentes : liquidity.usd"], anomalies: [] } as any });
  const a = assessToken({ score: s });
  assert.ok(a.uncertainties.some((r) => r.text === "Données absentes : liquidity.usd"));
  assert.ok(!a.negatives.some((r) => r.text === "Données absentes : liquidity.usd"));
});

test("no on-chain and no wallet analysis → uncertainties, base decision kept", () => {
  const a = assessToken({ score: score("MOMENTUM") });
  assert.equal(a.decision, "MOMENTUM");
  assert.deepEqual(facts(a)("uncertainties"), ["onchain:none", "wallets:none"]);
});

test("Quality 0 measured ≠ Quality UNKNOWN: measured weak is a (low) negative, UNKNOWN only an uncertainty", () => {
  const zero = intel([wf(W(0), { trades: closed(1, W(0), () => 0.2), funder: CREATOR })]);
  assert.deepEqual(zero.tracked[0].profile.quality, { status: "measured", value: 0 });
  assert.ok(has(assessToken({ score: score("WATCH"), wallets: zero }), "negatives", "wallets:belowThreshold"));
  const unk = intel([incompleteWallet(W(0))]);
  const a = assessToken({ score: score("WATCH"), wallets: unk });
  assert.ok(!has(a, "negatives", "wallets:belowThreshold"));
  assert.ok(has(a, "uncertainties", "wallets:qualityUnknown"));
});

test("fundedByCreator seen as a fundedBy relation and as a creator link → one reason", () => {
  // Step 4 sees W(0) funded by the deployment wallet, which is also tracked (fundedBy link W(0) ↔ CREATOR).
  const ws = intel([wf(W(0), { funder: CREATOR }), wf(CREATOR)]);
  assert.ok(ws.related.links.some((l) => l.type === "fundedBy"));
  const a = assessToken({ score: score("WATCH"), onchain: onchain(), wallets: ws });
  assert.ok(!a.negatives.some((r) => r.fact.startsWith("relation:fundedBy")));
  const r = a.negatives.find((x) => x.fact.startsWith("creator:fundedByCreator"))!;
  assert.deepEqual(r.sources, ["wallet_intel"]);
});

// ─── labels, rendering, regressions ──────────────────────────────────────

test("labels: only MOMENTUM / WATCH / CAUTION / AVOID / NO SIGNAL; never SAFE / GUARANTEED / BUY / SELL", () => {
  const src = readFileSync(new URL("../src/final/assessment.ts", import.meta.url), "utf8");
  assert.ok(!/["'](SAFE|GUARANTEED|BUY|SELL)["']/.test(src));
  const seen = new Set<string>();
  for (const l of ["MOMENTUM", "WATCH", "HIGH RISK", null] as const)
    for (const d of [data(), data({ mint: { freezeAuthority: key(8) } }), data({ mint: { mintAuthority: key(9) } })]) seen.add(assessToken({ score: score(l), onchain: onchain(d) }).decision);
  assert.deepEqual([...seen].sort(), ["AVOID", "CAUTION", "MOMENTUM", "NO SIGNAL", "WATCH"]);
});

test("formatAssessment: readable, no NaN / undefined / null / [object Object]", () => {
  const cases = [
    assessToken({ score: score("MOMENTUM"), onchain: onchain(data({ mint: { mintAuthority: key(9) } })), wallets: intel([wf(W(0)), incompleteWallet(W(1)), unknownWalletFacts(W(2), "history", "timeout", true)]) }),
    assessToken({ score: score(null) }),
    assessToken({ score: score("HIGH RISK"), onchain: onchain(data({ mint: { freezeAuthority: key(8) } })) }),
  ];
  for (const a of cases) {
    const t = formatAssessment(a);
    assert.ok(t.startsWith(`FINAL: ${a.decision}\nBASE: `), t);
    assert.ok(!/NaN|undefined|null|\[object Object\]/.test(t), t);
  }
  assert.ok(formatAssessment(cases[0]).includes("WHY CHANGED: caution structurelle confirmée — Mint authority ACTIVE"));
});

test("Step 3 output unchanged: redFlags keep their text and order; redFlagFacts only tag them", () => {
  const variants = [
    data(),
    data({ mint: { mintAuthority: key(9), freezeAuthority: key(8), extensions: [{ name: "permanentDelegate", state: { delegate: key(9) } }, { name: "transferHook", state: { programId: key(9) } }] } }),
    data({ mapWallets: (w, i) => (i < 3 ? { ...w, signatures: [...w.signatures, "bundle"] } : w) }),
    data({ creatorActivity: { status: "ok", value: { solBalance: 1, tokenPct: 9, recentSignatures: 5, analyzedTransactions: 5, events: [{ signature: "s", time: 1, kind: "sell", tokenDeltaPct: -3, recipients: [] }] } } }),
  ];
  for (const d of variants) {
    const a = analyzeOnchain(d);
    assert.deepEqual(a.redFlagFacts.map((f) => f.text), a.redFlags);
    assert.ok(a.redFlagFacts.every((f) => typeof f.key === "string" && f.key.length > 0));
  }
});

test("UI and script expose the final assessment", () => {
  const ui = readFileSync(new URL("../src/ui/ScoreDetail.tsx", import.meta.url), "utf8");
  assert.ok(ui.includes("<FinalAssessmentPanel"));
  const panel = readFileSync(new URL("../src/ui/FinalAssessmentPanel.tsx", import.meta.url), "utf8");
  assert.ok(panel.includes("FINAL ASSESSMENT") && panel.includes("assessToken("));
  const script = readFileSync(new URL("../scripts/wallets-live.ts", import.meta.url), "utf8");
  assert.ok(script.includes("formatAssessment(assessToken("));
});
