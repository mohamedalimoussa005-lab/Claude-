import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58Encode } from "../src/onchain/base58.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import { dataStatusText, formatQuality, formatRisk, presentFlags, profileWallet } from "../src/wallets/profile.ts";
import type { ProfileContext, WalletProfile } from "../src/wallets/profile.ts";
import { unknownWalletFacts } from "../src/wallets/resilience.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";

/**
 * B2: a complete history with no evaluable position has no numeric Wallet Quality
 * (UNKNOWN no_evaluable_position, Data Confidence LOW). Every wallet with ≥ 1
 * evaluable position keeps exactly its previous score. Fixtures only.
 */

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const CREATOR = key(90);
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;

const trade = (owner: string, mint: string, side: "buy" | "sell", sol: number, t: number, tokenAmount = 1000): Trade => ({ signature: `${owner}-${mint}-${side}-${t}`, slot: null, time: t, owner, mint, side, tokenAmount, sol });
/** n closed positions: 2/3 at +60 %, 1/3 at −20 %. */
const closed = (n: number, owner = W) =>
  Array.from({ length: n }, (_, i) => [trade(owner, key(100 + i), "buy", 1, min(-3000 + i * 60)), trade(owner, key(100 + i), "sell", i % 3 === 0 ? 0.8 : 1.6, min(-3000 + i * 60 + 30))]).flat();

const quietBot = { sampleSize: 60, spanMinutes: 20, txPerMinute: 0.1, trades: 4, distinctTokens: 4, roundTrips: 0, fastRoundTrips: 0, identicalAmountRoundTrips: 0, medianHoldSeconds: null, averageTicketSol: 1, highFrequency: false, fastFlipper: false, manyTokens: false, microTickets: false, botLike: false, evidence: [] as string[] };
const busyBot = { ...quietBot, txPerMinute: 3, highFrequency: true, fastFlipper: true, manyTokens: true, botLike: true, evidence: ["3.0 transactions/min sur 20 min"] };
const history = (o: { originSignature?: string; bot?: typeof quietBot; incomplete?: boolean } = {}): any => ({
  mode: "quick",
  completeness: o.incomplete ? "incomplete" : "recent_page_covers_history",
  signatureCountIsLowerBound: !!o.incomplete,
  origin: { found: true, firstSeen: null, signature: o.originSignature ?? "old", method: "recent_page", complete: !o.incomplete, reason: "found", signaturesScanned: 0, totalSignatures: null },
  bot: o.bot ?? quietBot,
  transfers: [],
  quickCompletion: o.incomplete ? { attempted: false, skippedReason: "history_too_long", stopReason: null, pages: 0 } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null, pages: 0 },
  deep: o.incomplete ? { attempted: false, skippedReason: "deep_disabled", stopReason: null } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null },
  providerTrace: [],
  unknowns: [],
});
/** Same shape as the pre-B2 reference snapshot (80 signatures, old funding). */
const facts = (o: Partial<WalletFacts> = {}): WalletFacts => ({
  address: W, signatureCount: 80, historyComplete: true, firstSeen: min(-43200), funder: key(50), fundingSignature: "old", fundingTime: min(-43200),
  funderSignatureCount: null, signatures: [], trades: [], historyNote: "complet", undecodableTxs: 0, history: history(), ...o,
});
const incomplete = (o: Partial<WalletFacts> = {}, bot = quietBot): WalletFacts =>
  facts({ signatureCount: 1000, historyComplete: false, trades: null, historyNote: "historique partiel", history: history({ incomplete: true, bot }), ...o });
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: CREATOR, creatorFunder: null, creatorFunding: null, launchTime: min(0), relatedTo: [], launchTimes: {}, pricesSol: {}, now: min(600), ...o });
const profile = (f: WalletFacts, c: Partial<ProfileContext> = {}) => profileWallet(f, ctx(c), min(1));

const NEP = { status: "unknown", reason: { code: "no_evaluable_position" } } as const;
const assertNoEvaluable = (p: WalletProfile) => {
  assert.equal(p.facts.trades !== null, true, "complete history");
  assert.equal(p.metrics!.evaluated, 0);
  assert.deepEqual(p.quality, NEP);
  assert.equal(p.dataConfidence, "LOW");
  assert.equal(p.confidence, "LOW");
  assert.deepEqual(p.qualityItems, [], "no score item, no 20/100, no implicit 0");
  assert.ok(!p.flags.some((x) => x.key === "incomplete"), "the history is complete");
  assert.equal(formatQuality(p.quality), "UNKNOWN (no_evaluable_position)");
};

const scan: TokenScan = { mint: key(1), launch: { time: min(0), slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: min(10 + i), owner: a, mint: key(1), side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 10 + i, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });
const intel = (fs: WalletFacts[]) =>
  buildIntel(scan, fs.map((f, i) => buyer(f.address, i)), fs, { creator: CREATOR, creatorFunder: null, creatorFunding: null, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: min(600) });

// ─── A–E: complete history, nothing evaluable ────────────────────────────

test("A: complete empty history → UNKNOWN no_evaluable_position, Data Confidence LOW (was measured 20)", () => {
  assertNoEvaluable(profile(facts({ trades: [] })));
  assertNoEvaluable(profile(facts({ trades: [], signatureCount: 0 })));
});

test("B: transfers only (no BUY/SELL decoded) → same result", () => {
  // tradesOf keeps BUY/SELL only: a transfer-only history reaches the profile as trades: [] (pipeline case in wallets-history.test.ts).
  const p = profile(facts({ trades: [], signatureCount: 3, undecodableTxs: 0 }));
  assertNoEvaluable(p);
  assert.equal(dataStatusText(p), "historique complet, mais aucune performance évaluable");
});

test("C: sells without a reconstructible buy → no position → UNKNOWN", () => {
  const p = profile(facts({ trades: [trade(W, key(100), "sell", 1, min(-100)), trade(W, key(101), "sell", 2, min(-90))] }));
  assert.equal(p.metrics!.positions.length, 0);
  assertNoEvaluable(p);
});

test("D: open positions without a price → UNKNOWN; the same positions with a price are measured (unchanged)", () => {
  const open = [trade(W, key(140), "buy", 1, min(-100)), trade(W, key(141), "buy", 2, min(-90))];
  const p = profile(facts({ trades: open }));
  assert.equal(p.metrics!.positions.length, 2);
  assertNoEvaluable(p);
  // Partially sold, priced → evaluable: pre-B2 value 24 kept.
  const partial = [trade(W, key(100), "buy", 1, min(-3000)), trade(W, key(100), "sell", 0.5, min(-2970), 500)];
  const priced = profile(facts({ trades: partial }), { pricesSol: { [key(100)]: 0.003 } });
  assert.deepEqual(priced.quality, { status: "measured", value: 24 });
});

test("E: transactions present but evaluated = 0 (mixed: open unpriced + sells only) → UNKNOWN", () => {
  const p = profile(facts({ trades: [trade(W, key(140), "buy", 1, min(-100)), trade(W, key(100), "sell", 1, min(-90)), trade(W, key(142), "buy", 0.5, min(-80))] }));
  assert.equal(p.metrics!.positions.length, 2);
  assertNoEvaluable(p);
});

// ─── F–J: ≥ 1 evaluable position → exactly the pre-B2 values ─────────────

// Recorded on ace7f33 with the same fixtures (80 signatures: buysEverything −5 from 24 tokens).
const BEFORE_B2: [n: number, quality: number, data: string, legacy: string][] = [
  [1, 22, "LOW", "LOW"],
  [9, 49, "LOW", "LOW"],
  [10, 52, "MEDIUM", "MEDIUM"],
  [24, 75, "MEDIUM", "MEDIUM"],
  [25, 75, "HIGH", "HIGH"],
  [30, 77, "HIGH", "HIGH"],
];

test("F–J: 1 / 9 / 10 / 24 / 25 (and 30) evaluable positions → measured, score and both confidences identical to pre-B2", () => {
  for (const [n, q, data, legacy] of BEFORE_B2) {
    const p = profile(facts({ trades: closed(n) }));
    assert.equal(p.metrics!.evaluated, n);
    assert.deepEqual(p.quality, { status: "measured", value: q }, `n=${n}`);
    assert.equal(p.dataConfidence, data, `n=${n}`);
    assert.equal(p.confidence, legacy, `n=${n}`);
    assert.equal(p.qualityItems.find((i) => i.label === "Complétude des données")?.points, 20, "completeness points kept");
  }
  // A real measured 0 still exists (one losing position − 25), and launch-known early entries are unchanged.
  const lose = [trade(W, key(100), "buy", 1, min(-3000)), trade(W, key(100), "sell", 0.2, min(-2970))];
  assert.deepEqual(profile(facts({ trades: lose, funder: CREATOR })).quality, { status: "measured", value: 0 });
  assert.deepEqual(profile(facts({ trades: closed(1) }), { launchTimes: { [key(100)]: min(-3002) } }).quality, { status: "measured", value: 23 });
  assert.deepEqual(profile(facts({ trades: closed(30), funder: CREATOR })).quality, { status: "measured", value: 52 });
});

// ─── K–L: missing history keeps its own reasons ──────────────────────────

test("K / L: history_incomplete, provider_failure and skipped stay UNKNOWN with Data Confidence UNKNOWN", () => {
  const inc = profile(incomplete());
  assert.equal(inc.quality.status === "unknown" && inc.quality.reason.code, "history_incomplete");
  assert.equal(inc.dataConfidence, "UNKNOWN");
  assert.equal(dataStatusText(inc), "historique incomplet");
  const fail = profile(unknownWalletFacts(W, "history", "timeout", false));
  assert.deepEqual(fail.quality, { status: "unknown", reason: { code: "provider_failure", kind: "timeout" } });
  assert.equal(fail.dataConfidence, "UNKNOWN");
  const skip = profile(unknownWalletFacts(W, "history", "network", true));
  assert.equal(skip.quality.status === "unknown" && skip.quality.reason.code, "skipped");
  assert.equal(skip.dataConfidence, "UNKNOWN");
});

// ─── M–N: observations and clusters kept ─────────────────────────────────

test("M: no_evaluable_position + risk flags → kept as observations, no penalty presented as removed", () => {
  const p = profile(facts({ trades: [], funder: CREATOR, firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first", history: history({ originSignature: "first", bot: busyBot }) }));
  assert.deepEqual(p.quality, NEP);
  assert.deepEqual(p.flags.map((x) => x.key), ["fundedByCreator", "busy", "fresh", "fundedBeforeLaunch"]);
  assert.equal(p.flags.find((x) => x.key === "fresh")!.suppressedBy, "fundedBeforeLaunch", "dedup unchanged");
  assert.equal(p.risk.maxApplied, null);
  assert.equal(p.risk.maxObserved, "high");
  assert.deepEqual(p.risk.applied, []);
  assert.deepEqual(p.risk.observedOnUnknown.map((x) => x.key), ["fundedByCreator", "busy", "fresh", "fundedBeforeLaunch"]);
  assert.deepEqual(presentFlags(p).penalised, []);
  assert.deepEqual(presentFlags(p).dataStatus, []);
  assert.ok(!p.qualityItems.some((i) => i.label.startsWith("Pénalités")));
  assert.ok(formatRisk(p.risk).includes("fundedByCreator HIGH (observé, Quality UNKNOWN)"));
});

test("N: no_evaluable_position + relation → related flag and cluster kept", () => {
  const out = intel([key(20), key(21)].map((a, i) => facts({ address: a, trades: [], signatures: ["bundle"], funder: key(60 + i), fundingSignature: `f${i}` })));
  assert.ok(out.related.links.some((l) => l.type === "sharedTx"));
  assert.equal(out.related.groups.length, 1);
  assert.equal(out.independentClusters, 1);
  for (const t of out.tracked) {
    assert.deepEqual(t.profile.quality, NEP);
    assert.ok(t.profile.risk.observedOnUnknown.some((x) => x.key === "related"));
  }
});

// ─── O–P: counters ───────────────────────────────────────────────────────

const mix = () => {
  const [A, B, C, D, E, F] = [30, 31, 32, 33, 34, 35].map(key);
  return [
    facts({ address: A, trades: closed(30, A), funder: key(51), fundingSignature: "fa" }), // measured 77, HIGH / HIGH
    facts({ address: B, trades: closed(10, B), funder: key(52), fundingSignature: "fb" }), // measured 52, MEDIUM
    facts({ address: C, trades: [], funder: key(53), fundingSignature: "fc" }), // no_evaluable_position
    facts({ address: D, trades: [trade(D, key(140), "buy", 1, min(-100))], funder: key(54), fundingSignature: "fd" }), // no_evaluable_position
    incomplete({ address: E, funder: key(55), fundingSignature: "fe" }),
    unknownWalletFacts(F, "history", "timeout", false),
  ];
};

test("O: measured / unknown / unknownByReason; no_evaluable_position is UNKNOWN, LOW data, in no high counter", () => {
  const out = intel(mix());
  assert.equal(out.tracked.length, 6);
  assert.equal(out.measured, 2);
  assert.equal(out.unknown, 4);
  assert.deepEqual(out.unknownByReason, { history_incomplete: 1, no_evaluable_position: 2, provider_failure: 1, skipped: 0 });
  assert.equal(out.historiesReconstructed, 4, "complete histories still counted as reconstructed");
  assert.equal(out.independentClusters, 6);
  assert.equal(out.highQuality, 1);
  assert.equal(out.highQualityMeasured, 1);
  assert.equal(out.highQualityWithoutHighRiskFlags, 1);
  assert.equal(out.highConfidence, 1);
  assert.equal(out.highConfidenceData, 1);
  const nep = out.tracked.filter((t) => t.profile.quality.status === "unknown" && t.profile.quality.reason.code === "no_evaluable_position");
  assert.deepEqual(nep.map((t) => [t.profile.dataConfidence, t.profile.confidence]), [["LOW", "LOW"], ["LOW", "LOW"]]);
});

test("P: high-quality counters unchanged for every wallet with ≥ 1 evaluable position", () => {
  const withEvaluable = mix().slice(0, 2);
  const a = intel(withEvaluable);
  const b = intel(mix());
  for (const k of ["highQuality", "highQualityMeasured", "highQualityWithoutHighRiskFlags", "highConfidence", "highConfidenceData"] as const) assert.equal(b[k], a[k], k);
  assert.equal(b.highQuality, b.highQualityMeasured);
});

// ─── Q–R: UI and script ──────────────────────────────────────────────────

test("Q: UI shows UNKNOWN (no_evaluable_position), Data Confidence, data status and Legacy Confidence", () => {
  const ui = readFileSync(new URL("../src/ui/WalletPanel.tsx", import.meta.url), "utf8");
  assert.ok(ui.includes("formatQuality(p.quality)") && ui.includes("Data status : {dataStatusText(p)}"));
  assert.ok(ui.includes("p.dataConfidence") && ui.includes("Legacy Confidence"));
  const p = profile(facts({ trades: [] }));
  assert.equal(dataStatusText(p), "historique complet, mais aucune performance évaluable");
  assert.ok(!/panne|échec|incomplet|suspect/i.test(dataStatusText(p)), "not a failure, not incomplete, not suspicious");
  assert.equal(dataStatusText(profile(facts({ trades: closed(10) }))), "historique complet, 10 position(s) évaluable(s)");
});

test("R: script line for no_evaluable_position — never WQ 20 / WQ 0 / NaN / null / undefined / [object Object]", () => {
  const script = readFileSync(new URL("../scripts/wallets-live.ts", import.meta.url), "utf8");
  assert.ok(script.includes("WQ ${formatQuality(p.quality)} · Data Confidence ${p.dataConfidence} · Legacy Confidence ${p.confidence}"));
  const p = profile(facts({ trades: [] }));
  const line = `WQ ${formatQuality(p.quality)} · Data Confidence ${p.dataConfidence} · Legacy Confidence ${p.confidence} · Risk ${formatRisk(p.risk)}`;
  assert.equal(line, "WQ UNKNOWN (no_evaluable_position) · Data Confidence LOW · Legacy Confidence LOW · Risk aucune");
  assert.ok(!/WQ 20|WQ 0|NaN|null|undefined|object Object/.test(line));
  assert.ok(!JSON.stringify(p.quality).includes("value"));
});

// ─── S: regressions (fixtures shaped like the recorded wallets; not live) ─

test("S: BUBBLE / DON / DOGRILLA expectations with B2", () => {
  // BUBBLE FHw4-like: one reconstructed, evaluable position → still measured.
  const fhw4 = facts({ trades: [trade(W, key(1), "buy", 4.77, min(0)), trade(W, key(1), "sell", 24.85, min(3))], funder: key(181) });
  const bubble = profileWallet(fhw4, ctx({ creatorFunder: key(181), creatorFunding: { signature: "cf", time: min(-2000), funderSignatureCount: 5000 } }), min(0));
  assert.equal(bubble.metrics!.evaluated, 1);
  assert.equal(bubble.quality.status, "measured");
  assert.equal(bubble.creatorLink?.strength, "weak");
  // DON BCByJu-like: long history → measured, HIGH / HIGH.
  const bc = profile(facts({ trades: closed(30) }));
  assert.deepEqual([bc.quality, bc.dataConfidence, bc.confidence], [{ status: "measured", value: 77 }, "HIGH", "HIGH"]);
  // DON 7sZa / 3TQB-like: incomplete + shared tx → history_incomplete, one cluster.
  const don = intel([key(40), key(41)].map((a, i) => incomplete({ address: a, signatures: ["shared"], funder: key(70 + i), fundingSignature: `d${i}` })));
  assert.equal(don.related.groups.length, 1);
  for (const t of don.tracked) assert.equal(t.profile.quality.status === "unknown" && t.profile.quality.reason.code, "history_incomplete");
  // DOGRILLA D12R-like: incomplete + bot-like → history_incomplete, busy kept.
  const d12r = profile(incomplete({}, busyBot));
  assert.equal(d12r.quality.status === "unknown" && d12r.quality.reason.code, "history_incomplete");
  assert.ok(d12r.flags.some((x) => x.key === "busy"));
});
