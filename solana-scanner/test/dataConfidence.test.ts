import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58Encode } from "../src/onchain/base58.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import { dedupePenalties, formatQuality, formatRisk, presentFlags, profileWallet, summarizeRisk } from "../src/wallets/profile.ts";
import type { ProfileContext, WalletFlag } from "../src/wallets/profile.ts";
import { addFailure, unknownWalletFacts } from "../src/wallets/resilience.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { qv } from "./helpers/quality.ts";

/**
 * B1: Data Confidence (data only) separated from risk observations (flags).
 * Legacy Confidence, Quality, flags, dedup and clusters unchanged. Fixtures only.
 */

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const CREATOR = key(90);
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;

const trade = (owner: string, mint: string, side: "buy" | "sell", sol: number, t: number): Trade => ({ signature: `${owner}-${mint}-${side}-${t}`, slot: null, time: t, owner, mint, side, tokenAmount: 1000, sol });
/** n closed positions: 2/3 at +60 %, 1/3 at −20 % (the shape of the existing HIGH-confidence test). */
const closed = (n: number, owner = W) =>
  Array.from({ length: n }, (_, i) => [trade(owner, key(100 + i), "buy", 1, min(-3000 + i * 60)), trade(owner, key(100 + i), "sell", i % 3 === 0 ? 0.8 : 1.6, min(-3000 + i * 60 + 30))]).flat();
/** n closed positions, all doubled, bought within the first minute of each token's launch (raw Quality 100). */
const perfect = (n: number, owner: string) =>
  Array.from({ length: n }, (_, i) => [trade(owner, key(100 + i), "buy", 1, min(-3000 + i * 60)), trade(owner, key(100 + i), "sell", 2, min(-3000 + i * 60 + 30))]).flat();
const perfectLaunches = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [key(100 + i), min(-3000 + i * 60) - 60_000]));

const quietBot = { sampleSize: 60, spanMinutes: 20, txPerMinute: 0.1, trades: 4, distinctTokens: 4, roundTrips: 0, fastRoundTrips: 0, identicalAmountRoundTrips: 0, medianHoldSeconds: null, averageTicketSol: 1, highFrequency: false, fastFlipper: false, manyTokens: false, microTickets: false, botLike: false, evidence: [] as string[] };
const busyBot = { ...quietBot, txPerMinute: 3, trades: 24, distinctTokens: 12, roundTrips: 12, fastRoundTrips: 12, highFrequency: true, fastFlipper: true, manyTokens: true, botLike: true, evidence: ["3.0 transactions/min sur 20 min"] };
const history = (o: { originSignature?: string | null; bot?: typeof quietBot; incomplete?: boolean } = {}): any => ({
  mode: "quick",
  completeness: o.incomplete ? "incomplete" : "recent_page_covers_history",
  signatureCountIsLowerBound: !!o.incomplete,
  origin: { found: true, firstSeen: null, signature: o.originSignature ?? null, method: "recent_page", complete: !o.incomplete, reason: "found", signaturesScanned: 0, totalSignatures: null },
  bot: o.bot ?? quietBot,
  transfers: [],
  quickCompletion: o.incomplete ? { attempted: false, skippedReason: "history_too_long", stopReason: null, pages: 0 } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null, pages: 0 },
  deep: o.incomplete ? { attempted: false, skippedReason: "deep_disabled", stopReason: null } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null },
  providerTrace: [],
  unknowns: [],
});
// 2,000 signatures: no buysEverything noise from the fixture's token count, below the busy threshold.
const facts = (o: Partial<WalletFacts> = {}): WalletFacts => ({
  address: W, signatureCount: 2000, historyComplete: true, firstSeen: min(-30 * 24 * 60), funder: key(50), fundingSignature: "old-funding", fundingTime: min(-30 * 24 * 60),
  funderSignatureCount: null, signatures: [], trades: closed(4), historyNote: "historique complet", undecodableTxs: 0, history: history({ originSignature: "old-funding" }), ...o,
});
const incomplete = (o: Partial<WalletFacts> = {}, bot = quietBot): WalletFacts =>
  facts({ signatureCount: 1000, historyComplete: false, trades: null, historyNote: "historique partiel", history: history({ originSignature: "old-funding", incomplete: true, bot }), ...o });
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: CREATOR, creatorFunder: null, creatorFunding: null, launchTime: min(0), relatedTo: [], launchTimes: {}, pricesSol: {}, now: min(600), ...o });
const profile = (f: WalletFacts, c: Partial<ProfileContext> = {}) => profileWallet(f, ctx(c), min(1));

const scan: TokenScan = { mint: key(1), launch: { time: min(0), slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: min(10 + i), owner: a, mint: key(1), side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 10 + i, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });
const intel = (fs: WalletFacts[], launchTimes: Record<string, number> = {}) =>
  buildIntel(scan, fs.map((f, i) => buyer(f.address, i)), fs, { creator: CREATOR, creatorFunder: null, creatorFunding: null, holdersPct: null, excluded: () => false, launchTimes, pricesSol: {}, now: min(600) });

// ─── Data Confidence thresholds ──────────────────────────────────────────

test("thresholds: 0 → LOW (measured), 9 → LOW, 10 → MEDIUM, 24 → MEDIUM, 25 → HIGH; legacy identical without flags", () => {
  for (const [n, level] of [[0, "LOW"], [9, "LOW"], [10, "MEDIUM"], [24, "MEDIUM"], [25, "HIGH"], [30, "HIGH"]] as const) {
    const p = profile(facts({ trades: closed(n) }));
    assert.equal(p.quality.status, "measured", `n=${n}`);
    assert.equal(p.metrics!.evaluated, n);
    assert.equal(p.dataConfidence, level, `n=${n}`);
    assert.equal(p.confidence, level, `legacy n=${n}`);
  }
});

test("n counts evaluable positions, not reconstructed ones: an open position without price stays LOW", () => {
  const trades = [...closed(9), trade(W, key(200), "buy", 1, min(-100))];
  const p = profile(facts({ trades }));
  assert.equal(p.metrics!.positions.length, 10);
  assert.equal(p.metrics!.evaluated, 9);
  assert.equal(p.dataConfidence, "LOW");
});

test("Quality UNKNOWN → Data Confidence UNKNOWN: incomplete, provider_failure, skipped (legacy stays LOW)", () => {
  const cases = [profile(incomplete()), profile(unknownWalletFacts(W, "history", "quota_exhausted", false)), profile(unknownWalletFacts(W, "history", "timeout", true))];
  assert.deepEqual(cases.map((p) => p.quality.status === "unknown" && p.quality.reason.code), ["history_incomplete", "provider_failure", "skipped"]);
  for (const p of cases) {
    assert.equal(p.dataConfidence, "UNKNOWN");
    assert.equal(p.confidence, "LOW");
  }
});

test("complete history after a successful fallback: level from n only", () => {
  const f = facts({ trades: closed(12) });
  addFailure(f, "funder_check", "rate_limited");
  const p = profile(f);
  assert.equal(p.dataConfidence, "MEDIUM");
  assert.deepEqual(p.quality, profile(facts({ trades: closed(12) })).quality);
});

// ─── data vs risk ────────────────────────────────────────────────────────

test("30 positions + fundedByCreator HIGH: Data Confidence HIGH, legacy MEDIUM, Quality unchanged (82 − 25)", () => {
  const clean = profile(facts({ trades: closed(30) }));
  const p = profile(facts({ trades: closed(30), funder: CREATOR }));
  assert.equal(qv(p.quality), qv(clean.quality) - WALLET_CONFIG.quality.penalties.high);
  assert.equal(qv(p.quality), 57);
  assert.equal(p.dataConfidence, "HIGH");
  assert.equal(p.confidence, "MEDIUM");
  assert.equal(p.risk.maxObserved, "high");
  assert.equal(p.risk.maxApplied, "high");
  assert.deepEqual(p.risk.applied.map((x) => x.key), ["fundedByCreator"]);
  assert.equal(formatRisk(p.risk), "fundedByCreator HIGH");
});

test("several HIGH flags: Data Confidence unchanged, legacy cap applied once (MEDIUM, never LOW)", () => {
  const f = facts({ trades: closed(30), funder: CREATOR, firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first", history: history({ originSignature: "first" }) });
  const p = profile(f);
  assert.deepEqual(p.risk.applied.map((x) => [x.key, x.severity]), [["fundedByCreator", "high"], ["fundedBeforeLaunch", "high"]]);
  assert.deepEqual(p.risk.neutralised.map((x) => [x.key, x.suppressedBy]), [["fresh", "fundedBeforeLaunch"]]);
  assert.equal(p.dataConfidence, "HIGH");
  assert.equal(p.confidence, "MEDIUM");
  assert.equal(qv(p.quality), 32, "penalties unchanged (additive): 82 − 25 − 25");
});

test("neutralised HIGH flag: never counted as applied, so no undue cap", () => {
  // Unreachable through profileWallet today (a high flag is always the strongest of its group and
  // fundedByCreator / sameFunderAsCreator exclude each other): checked on the derived view directly.
  const mk = (key: string): WalletFlag => ({ key, label: key, severity: "high", detail: "", group: "funding_link", evidence: ["funding:self"], penaltyApplied: true, suppressedBy: null });
  const flags = dedupePenalties([mk("fundedByCreator"), mk("sameFunderAsCreator")]);
  const r = summarizeRisk(flags, { status: "measured", value: 50 });
  assert.deepEqual(r.applied.map((x) => x.key), ["fundedByCreator"]);
  assert.deepEqual(r.neutralised.map((x) => [x.key, x.suppressedBy]), [["sameFunderAsCreator", "fundedByCreator"]]);
  const onlyNeutralised = summarizeRisk([{ ...mk("x"), penaltyApplied: false, suppressedBy: "y" }], { status: "measured", value: 50 });
  assert.equal(onlyNeutralised.maxApplied, null);
  assert.equal(onlyNeutralised.maxObserved, "high");
  // A neutralised medium flag never caps the legacy indicator either.
  const p = profile(facts({ trades: closed(30) }), { relatedTo: [key(21)], relatedLinks: [{ type: "sameFunder", other: key(21), key: key(50) } as any], creatorFunder: key(50), creatorFunding: { signature: "c", time: min(-90 * 24 * 60), funderSignatureCount: 40 } });
  assert.equal(p.risk.neutralised.some((x) => x.key === "related"), true);
  assert.equal(p.confidence, "HIGH");
  assert.equal(p.dataConfidence, "HIGH");
});

test("Quality UNKNOWN: observations only — no applied penalty, incomplete is not a risk", () => {
  const p = profile(incomplete({ funder: CREATOR }, busyBot));
  assert.equal(p.risk.maxApplied, null);
  assert.equal(p.risk.maxObserved, "high");
  assert.deepEqual(p.risk.applied, []);
  assert.deepEqual(p.risk.neutralised, []);
  assert.deepEqual(p.risk.observedOnUnknown.map((x) => x.key).sort(), ["busy", "fundedByCreator"]);
  assert.ok(!formatRisk(p.risk).includes("incomplete"));
  assert.equal(formatRisk(p.risk), "fundedByCreator HIGH (observé, Quality UNKNOWN), busy MEDIUM (observé, Quality UNKNOWN)");
  assert.deepEqual(presentFlags(p).dataStatus.map((x) => x.key), ["incomplete"]);
  assert.equal(formatRisk(profile(facts()).risk), "aucune");
});

test("Quality UNKNOWN + related: observations and cluster kept", () => {
  const out = intel([key(20), key(21)].map((a, i) => incomplete({ address: a, signatures: ["bundle"], funder: key(60 + i), fundingSignature: `f${i}` })));
  assert.equal(out.related.groups.length, 1);
  assert.equal(out.independentClusters, 1);
  for (const t of out.tracked) {
    assert.equal(t.profile.dataConfidence, "UNKNOWN");
    assert.ok(t.profile.risk.observedOnUnknown.some((x) => x.key === "related"));
  }
});

// ─── counters ────────────────────────────────────────────────────────────

const mixFacts = () => {
  const A = key(30), B = key(31), C = key(32), D = key(33), E = key(34), F = key(35);
  return [
    facts({ address: A, trades: closed(30, A), funder: key(51), fundingSignature: "fa" }), // Q 82, data HIGH, legacy HIGH
    facts({ address: B, trades: perfect(50, B), funder: CREATOR, fundingSignature: "fb" }), // Q 75 despite −25, data HIGH, legacy MEDIUM
    facts({ address: C, trades: closed(10, C), funder: key(52), fundingSignature: "fc" }), // Q 52, MEDIUM
    incomplete({ address: D, funder: key(53), fundingSignature: "fd" }),
    unknownWalletFacts(E, "history", "timeout", false),
    unknownWalletFacts(F, "history", "network", true),
  ];
};

test("counters: legacy kept, data-only counters added", () => {
  const out = intel(mixFacts(), perfectLaunches(50));
  const byAddr = Object.fromEntries(out.tracked.map((t) => [t.address, t.profile]));
  assert.equal(qv(byAddr[key(31)].quality), 75);
  assert.deepEqual([byAddr[key(31)].dataConfidence, byAddr[key(31)].confidence], ["HIGH", "MEDIUM"]);
  assert.equal(out.highQuality, 2);
  assert.equal(out.highQualityMeasured, 2);
  assert.equal(out.highQualityWithoutHighRiskFlags, 1);
  assert.equal(out.highConfidence, 1, "legacy: the capped wallet is MEDIUM");
  assert.equal(out.highConfidenceData, 2);
  assert.equal(out.measured, 3);
  assert.equal(out.unknown, 3);
  assert.equal(out.independentClusters, 6);
});

test("highQualityMeasured and highQuality select the same wallets (n from 0 to 30, with and without flags)", () => {
  const variants: WalletFacts[] = [];
  let i = 0;
  for (const n of [0, 1, 9, 10, 24, 25, 30, 50]) {
    for (const funder of [key(50), CREATOR]) {
      const a = key(120 + i++);
      variants.push(facts({ address: a, trades: n === 50 ? perfect(50, a) : closed(n, a), funder, fundingSignature: `f-${a}` }));
    }
  }
  variants.push(incomplete({ address: key(250), fundingSignature: "u" }));
  const launches = perfectLaunches(50);
  for (const f of variants) {
    const out = intel([f], launches);
    assert.equal(out.highQualityMeasured, out.highQuality, f.address);
  }
});

// ─── rendering ───────────────────────────────────────────────────────────

test("UI and script render Data Confidence, legacy Confidence and risk separately, never raw objects", () => {
  const ui = readFileSync(new URL("../src/ui/WalletPanel.tsx", import.meta.url), "utf8");
  assert.ok(ui.includes("Data Confidence") && ui.includes("Legacy Confidence") && ui.includes("Risk observations : {formatRisk(p.risk)}"));
  assert.ok(ui.includes("p.dataConfidence") && ui.includes("t.profile.dataConfidence"));
  const script = readFileSync(new URL("../scripts/wallets-live.ts", import.meta.url), "utf8");
  assert.ok(script.includes("Data Confidence ${p.dataConfidence}") && script.includes("Legacy Confidence ${p.confidence}") && script.includes("Risk ${formatRisk(p.risk)}"));
  for (const p of [profile(incomplete()), profile(facts({ trades: closed(30), funder: CREATOR })), profile(unknownWalletFacts(W, "history", "timeout", false))]) {
    const line = `WQ ${formatQuality(p.quality)} · Data Confidence ${p.dataConfidence} · Legacy Confidence ${p.confidence} · Risk ${formatRisk(p.risk)}`;
    assert.ok(!/object Object|NaN|undefined|null/.test(line), line);
    if (p.quality.status === "unknown") assert.ok(line.startsWith("WQ UNKNOWN (") && line.includes("Data Confidence UNKNOWN"), line);
  }
});

// ─── regressions (fixtures shaped like the recorded wallets; not live) ───

test("BUBBLE / DON / DOGRILLA regressions", () => {
  // BUBBLE FHw4-like: one reconstructed position, shared busy funder → measured, LOW / LOW, no applied high.
  const fhw4 = facts({ trades: [trade(W, key(1), "buy", 4.77, min(0)), trade(W, key(1), "sell", 24.85, min(3))], funder: key(181) });
  const bubble = profileWallet(fhw4, ctx({ creatorFunder: key(181), creatorFunding: { signature: "cf", time: min(-2000), funderSignatureCount: 5000 } }), min(0));
  assert.deepEqual([bubble.quality.status, bubble.dataConfidence, bubble.confidence, bubble.risk.maxApplied], ["measured", "LOW", "LOW", null]);
  // DON BCByJu-like: long complete history without high flag → HIGH / HIGH.
  const bc = profile(facts({ trades: closed(30) }));
  assert.deepEqual([bc.dataConfidence, bc.confidence], ["HIGH", "HIGH"]);
  // DON 7sZa / 3TQB-like: incomplete, shared transaction → UNKNOWN / LOW, still one cluster.
  const don = intel([key(40), key(41)].map((a, i) => incomplete({ address: a, signatures: ["shared"], funder: key(70 + i), fundingSignature: `d${i}` })));
  assert.equal(don.related.groups.length, 1);
  for (const t of don.tracked) assert.deepEqual([t.profile.dataConfidence, t.profile.confidence], ["UNKNOWN", "LOW"]);
  // DOGRILLA D12R-like: incomplete + bot-like → UNKNOWN / LOW, busy kept as an observation.
  const d12r = profile(incomplete({}, busyBot));
  assert.deepEqual([d12r.dataConfidence, d12r.confidence], ["UNKNOWN", "LOW"]);
  assert.deepEqual(d12r.risk.observedOnUnknown.map((x) => x.key), ["busy"]);
});
