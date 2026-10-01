import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import { profileWallet } from "../src/wallets/profile.ts";
import type { ProfileContext, WalletProfile } from "../src/wallets/profile.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";
import { qv } from "./helpers/quality.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const CREATOR = key(90);
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;

/**
 * Duplicate penalties (same evidence, same phenomenon). BEFORE = commit 21b3f6c
 * (every flag penalised), captured by these tests before the fix; AFTER = the
 * strongest existing penalty of the group applies once, the other flags stay
 * descriptive with penaltyApplied = false.
 */
const BEFORE = {
  ref1: { raw: 33.7, penalties: 37, quality: 0, confidence: "LOW" },
  ref2: { raw: 56.9, penalties: 29, quality: 28, confidence: "MEDIUM" },
  ref3: { raw: 33.7, penalties: 37, quality: 0, confidence: "LOW" },
  ref3b: { penalties: 24, quality: 10 },
};
const suppressed = (p: WalletProfile) => p.flags.filter((f) => !f.penaltyApplied && f.suppressedBy !== null).map((f) => `${f.key}<${f.suppressedBy}`);

/** Profile summary: what the score is made of. */
export function summary(p: WalletProfile) {
  const raw = Math.round(p.qualityItems.filter((i) => i.max > 0 || i.points > 0).reduce((s, i) => s + i.points, 0) * 10) / 10;
  const penaltyItem = p.qualityItems.find((i) => i.label.startsWith("Pénalités (motifs suspects)"));
  return {
    flags: p.flags.map((f) => f.key),
    raw,
    penalties: penaltyItem ? -penaltyItem.points : 0,
    quality: qv(p.quality),
    confidence: p.confidence,
  };
}

const trade = (mint: string, side: "buy" | "sell", sol: number, t: number): Trade => ({ signature: `${mint}-${side}-${t}`, slot: null, time: t, owner: W, mint, side, tokenAmount: 1000, sol });
/** n closed, profitable positions on distinct tokens. */
const closedTrades = (n: number, solIn: number, solOut: number, start = min(-2000)) =>
  Array.from({ length: n }, (_, i) => [trade(key(100 + i), "buy", solIn, start + i * 60_000), trade(key(100 + i), "sell", solOut, start + i * 60_000 + 30_000)]).flat();

const bot = (o: Partial<Record<string, unknown>> = {}) => ({
  sampleSize: 60, spanMinutes: 20, txPerMinute: 3, trades: 24, distinctTokens: 12, roundTrips: 12, fastRoundTrips: 12, identicalAmountRoundTrips: 12, medianHoldSeconds: 30, averageTicketSol: 0.005,
  highFrequency: true, fastFlipper: true, manyTokens: true, microTickets: true, botLike: true, evidence: ["3.0 transactions/min sur 20 min"], ...o,
});
const history = (o: { originSignature?: string | null; bot?: ReturnType<typeof bot> } = {}): any => ({
  mode: "quick", completeness: "recent_page_covers_history", signatureCountIsLowerBound: false,
  origin: { found: true, firstSeen: null, signature: o.originSignature ?? null, method: "recent_page", complete: true, reason: "found", signaturesScanned: 0, totalSignatures: null },
  bot: o.bot ?? bot({ highFrequency: false, fastFlipper: false, manyTokens: false, microTickets: false, botLike: false, evidence: [] }),
  transfers: [], quickCompletion: { attempted: false, skippedReason: "complete_from_quick", stopReason: null, pages: 0 }, deep: { attempted: false, skippedReason: "complete_from_quick", stopReason: null }, providerTrace: [], unknowns: [],
});
const facts = (o: Partial<WalletFacts> = {}): WalletFacts => ({
  address: W, signatureCount: 40, historyComplete: true, firstSeen: min(-30 * 24 * 60), funder: key(50), fundingSignature: "old-funding", fundingTime: min(-30 * 24 * 60),
  funderSignatureCount: null, signatures: [], trades: closedTrades(4, 1, 1.5), historyNote: "historique complet", undecodableTxs: 0, history: history({ originSignature: "old-funding" }), ...o,
});
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: CREATOR, creatorFunder: null, creatorFunding: null, launchTime: min(0), relatedTo: [], launchTimes: {}, pricesSol: {}, now: min(600), ...o });

// ─── 1. fresh + fundedBeforeLaunch: one funding event ────────────────────

test("REF 1: fresh + fundedBeforeLaunch from the same first transaction (the funding)", () => {
  // First (and funding) transaction 30 min before launch; entry 1 min after launch.
  const f = facts({ firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first-tx", history: history({ originSignature: "first-tx" }) });
  const p = profileWallet(f, ctx(), min(1));
  const s = summary(p);
  assert.deepEqual(s.flags, ["fresh", "fundedBeforeLaunch"], "both stay visible");
  assert.deepEqual(p.flags.map((x) => x.evidence), [["tx:first-tx"], ["tx:first-tx"]], "same provenance");
  assert.deepEqual(suppressed(p), ["fresh<fundedBeforeLaunch"]);
  assert.equal(BEFORE.ref1.penalties, 37);
  assert.deepEqual({ raw: s.raw, penalties: s.penalties, quality: s.quality, confidence: s.confidence }, { raw: 33.7, penalties: 25, quality: 9, confidence: "LOW" });
  assert.ok(p.qualityItems.some((i) => i.label.startsWith("Pénalités neutralisées") && i.detail.includes("Wallet créé très récemment")));
});

test("REF 1 counter-example: fresh and fundedBeforeLaunch from two different transactions", () => {
  // First activity 40 h before entry (fresh), but the funding identified on another transaction 30 min before launch.
  const f = facts({ firstSeen: min(-40 * 60), fundingTime: min(-30), fundingSignature: "funding-tx", history: history({ originSignature: "first-tx" }) });
  const p = profileWallet(f, ctx(), min(1));
  const s = summary(p);
  assert.deepEqual(s.flags, ["fresh", "fundedBeforeLaunch"]);
  assert.deepEqual(suppressed(p), [], "independent evidence: both penalised");
  assert.equal(s.penalties, 37);
});

// ─── 2. busy + micro + buysEverything ────────────────────────────────────

const autoTrades = closedTrades(12, 0.005, 0.006); // 24 trades, 12 tokens, average ticket 0.0055 SOL

test("REF 2: bot-like on many tokens + micro tickets + buys almost every token (complete history)", () => {
  const f = facts({ trades: autoTrades, signatureCount: 40, history: history({ originSignature: "old-funding", bot: bot() }) });
  const p = profileWallet(f, ctx(), min(1));
  const s = summary(p);
  assert.deepEqual(s.flags, ["busy", "micro", "buysEverything"]);
  // Token breadth made the wallet bot-like and is what buysEverything measures; ticket size is not a busy criterion.
  assert.deepEqual(suppressed(p), ["buysEverything<busy"]);
  assert.ok(p.flags.find((x) => x.key === "micro")!.penaltyApplied, "micro tickets: independent of busy");
  assert.equal(BEFORE.ref2.penalties, 29);
  assert.deepEqual({ raw: s.raw, penalties: s.penalties, quality: s.quality, confidence: s.confidence }, { raw: 56.9, penalties: 24, quality: 33, confidence: "MEDIUM" });
});

test("REF 2 counter-example: bot-like from fast flips only (token breadth not part of it) + buys almost every token", () => {
  const f = facts({ trades: autoTrades, signatureCount: 40, history: history({ originSignature: "old-funding", bot: bot({ manyTokens: false, distinctTokens: 6, microTickets: false }) }) });
  const p = profileWallet(f, ctx(), min(1));
  const s = summary(p);
  assert.deepEqual(s.flags, ["busy", "micro", "buysEverything"]);
  assert.deepEqual(suppressed(p), [], "bot-like without token breadth: three independent penalties");
  assert.equal(s.penalties, 29);
});

// ─── 3. creatorLink + related: one funder ────────────────────────────────

const scan: TokenScan = { mint: key(1), launch: { time: min(0), slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: min(10 + i), owner: a, mint: key(1), side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 10 + i, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });
const pairFacts = (o: { funder: string; count: number; gapMin: number; shared?: boolean }): WalletFacts[] =>
  [key(20), key(21)].map((a, i) => ({
    ...facts(),
    address: a,
    funder: o.funder,
    funderSignatureCount: o.count,
    fundingSignature: `fund-${i}`,
    firstSeen: min(-5000 - i * o.gapMin),
    fundingTime: min(-5000 - i * o.gapMin),
    signatures: [`fund-${i}`, ...(o.shared ? ["bundle"] : [])],
    history: history({ originSignature: `fund-${i}` }),
  }));
const intel = (fs: WalletFacts[], c: Partial<ProfileContext> = {}) =>
  buildIntel(scan, fs.map((f, i) => buyer(f.address, i)), fs, { creator: CREATOR, creatorFunder: c.creatorFunder ?? null, creatorFunding: c.creatorFunding ?? null, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: min(600) });

test("REF 3: two wallets funded by the deployment wallet (counted not busy, 2 min apart) → fundedByCreator + related from one funder", () => {
  const out = intel(pairFacts({ funder: CREATOR, count: 40, gapMin: 2 }));
  assert.equal(out.related.links[0].type, "sameFunderClose");
  assert.equal(out.related.groups.length, 1, "the cluster itself is unchanged");
  for (const t of out.tracked) {
    const s = summary(t.profile);
    assert.deepEqual(s.flags, ["fundedByCreator", "related"]);
    assert.deepEqual(suppressed(t.profile), ["related<fundedByCreator"]);
    assert.equal(BEFORE.ref3.penalties, 37);
    assert.deepEqual({ raw: s.raw, penalties: s.penalties, quality: s.quality, confidence: s.confidence }, { raw: 33.7, penalties: 25, quality: 9, confidence: "LOW" });
  }
});

test("REF 3b: same funder (counted not busy, distant) for both wallets and the deployment wallet → sameFunderAsCreator medium + related", () => {
  const F = key(60);
  const out = intel(pairFacts({ funder: F, count: 40, gapMin: 3 * 24 * 60 }), { creatorFunder: F, creatorFunding: { signature: "creator-funding", time: min(-20_000), funderSignatureCount: 40 } });
  assert.equal(out.related.links[0].type, "sameFunder");
  for (const t of out.tracked) {
    const s = summary(t.profile);
    assert.deepEqual(s.flags, ["sameFunderAsCreator", "related"]);
    assert.deepEqual(suppressed(t.profile), ["related<sameFunderAsCreator"]);
    assert.equal(BEFORE.ref3b.penalties, 24);
    assert.deepEqual({ penalties: s.penalties, quality: s.quality }, { penalties: 12, quality: 22 });
  }
});

test("REF 3 counter-example: fundedByCreator + related justified by an independent shared transaction", () => {
  const out = intel(pairFacts({ funder: CREATOR, count: 40, gapMin: 2, shared: true }));
  assert.ok(out.related.links.some((l) => l.type === "sharedTx"));
  for (const t of out.tracked) {
    const s = summary(t.profile);
    assert.deepEqual(s.flags, ["fundedByCreator", "related"]);
    assert.deepEqual(suppressed(t.profile), [], "related also rests on a shared transaction: kept");
    assert.equal(s.penalties, 37);
  }
});

// ─── insufficient provenance: current behaviour kept ─────────────────────

test("LIMIT: first-activity provenance unknown (no origin signature) → fresh keeps its penalty next to fundedBeforeLaunch", () => {
  const f = facts({ firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first-tx", history: undefined });
  const p = profileWallet(f, ctx(), min(1));
  assert.deepEqual(p.flags.find((x) => x.key === "fresh")!.evidence, []);
  assert.deepEqual(suppressed(p), []);
  assert.equal(summary(p).penalties, 37);
});

test("LIMIT: related without link provenance (no relatedLinks) → never suppressed", () => {
  const p = profileWallet({ ...facts(), funder: CREATOR }, ctx({ relatedTo: [key(21)] }), min(1));
  assert.deepEqual(p.flags.map((x) => x.key), ["fundedByCreator", "related"]);
  assert.deepEqual(p.flags.find((x) => x.key === "related")!.evidence, []);
  assert.deepEqual(suppressed(p), []);
  assert.equal(summary(p).penalties, 37);
});

test("LIMIT: busy by signature count only (≥ 5,000) + incomplete: no shared evidence, Quality UNKNOWN (never an implicit 0)", () => {
  const p = profileWallet(facts({ trades: null, historyComplete: false, signatureCount: 6000 }), ctx(), min(1));
  assert.deepEqual(p.flags.map((x) => x.key), ["busy", "incomplete"]);
  assert.deepEqual(suppressed(p), []);
  assert.deepEqual(p.quality, { status: "unknown", reason: { code: "history_incomplete", details: [] } });
  assert.equal(p.flags.find((x) => x.key === "busy")!.penaltyApplied, true, "observation kept as is");
  assert.equal(p.confidence, "LOW");
});

test("Confidence cap unchanged: an applied high flag still caps HIGH; a suppressed medium flag never matters", () => {
  const many = closedTrades(30, 1, 1.5);
  const f = facts({ trades: many, signatureCount: 70, firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first-tx", history: history({ originSignature: "first-tx" }) });
  const p = profileWallet(f, ctx(), min(1));
  assert.deepEqual(suppressed(p), ["fresh<fundedBeforeLaunch"]);
  assert.equal(p.confidence, "MEDIUM", "fundedBeforeLaunch (high, applied) caps HIGH as before");
});
