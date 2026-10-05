import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { assessToken } from "../src/final/assessment.ts";
import { exportRows, formatReport, toCsv } from "../src/outcomes/report.ts";
import { addObservations, loadStore, replaceOutcomes, saveStore } from "../src/outcomes/store.ts";
import { applyFetch, buildObservation, CHECKPOINTS, checkpointState, dueCheckpoints, hashSnapshot, observedPath, returnPct } from "../src/outcomes/tracker.ts";
import type { CheckpointKey, Observation } from "../src/outcomes/tracker.ts";
import { scorePair } from "../src/scoring/score.ts";
import { okDecisionMarket, step2Timeline } from "./helpers/outcomes.ts";

/** Offline fixtures only: real Step 2 scoring + real FinalAssessment, synthetic market data. */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const pair = (o: Partial<NormalizedPair> = {}): NormalizedPair => ({
  chainId: "solana", dexId: "pumpswap", url: null, pairAddress: "PAIR_A", tokenAddress: "MINT_1", tokenName: "Fixture", tokenSymbol: "FIX", quoteSymbol: "SOL",
  priceUsd: 0.001, marketCap: 400_000, fdv: 400_000, liquidityUsd: 60_000, volumeM5: 9_000, volumeH1: 70_000, volumeH6: 200_000, volumeH24: 400_000,
  buysM5: 40, sellsM5: 20, buysH1: 500, sellsH1: 300, priceChangeM5: 4, priceChangeH1: 30, priceChangeH6: 60, pairCreatedAt: T0 - 4 * 60 * MIN, ...o,
});
const observe = (p: NormalizedPair = pair(), capturedAt = T0): Observation => {
  const score = scorePair(p, capturedAt);
  return buildObservation({ pair: p, score, assessment: assessToken({ score }), timeline: step2Timeline(capturedAt), decisionMarket: okDecisionMarket(p, capturedAt), candidate: false, onchain: null, step3Status: "NOT_RUN", wallets: null, step4Status: "NOT_RUN", scannerCommit: "test" });
};
const at = (key: CheckpointKey, extraMin = 0) => T0 + CHECKPOINTS.find((c) => c.key === key)!.ms + extraMin * MIN;
const ok = (price: number | null, o: Partial<NormalizedPair> = {}) => ({ status: "OK" as const, pair: pair({ priceUsd: price, ...o }) });
const snap = (o: Observation) => JSON.stringify(o.snapshot);

// ─── A–L: anti-lookahead / data leakage ───────────────────────────────────

test("A: T0 snapshot holds what the scanner knew, detached and hashed", () => {
  const p = pair();
  const score = scorePair(p, T0);
  const fa = assessToken({ score });
  const o = buildObservation({ pair: p, score, assessment: fa, timeline: step2Timeline(T0), decisionMarket: okDecisionMarket(p, T0), candidate: false, onchain: null, step3Status: "NOT_RUN", wallets: null, step4Status: "NOT_RUN" });
  assert.equal(o.snapshot.observationId, `MINT_1:PAIR_A:${T0}`);
  assert.equal(o.snapshot.market.priceUsd, 0.001);
  assert.deepEqual([o.snapshot.step2.opportunity, o.snapshot.step2.label, o.snapshot.final.decision], [score.opportunity, score.label, fa.decision]);
  assert.deepEqual(o.snapshot.funnel, { seenInScan: true, candidate: false, step3Status: "NOT_RUN", step4Status: "NOT_RUN", finalAssessment: true });
  assert.equal(o.snapshot.step3, null, "Step 3 not run: nothing fabricated");
  assert.equal(o.snapshot.step4, null);
  assert.deepEqual(o.outcomes, {});
  assert.equal(o.snapshotHash, hashSnapshot(o.snapshot));
  // Detached: mutating the scanner's objects afterwards does not reach the snapshot.
  (fa.positives as any).push({ fact: "x" });
  assert.equal(o.snapshotHash, hashSnapshot(o.snapshot));
});

test("B: the +5m update changes no snapshot field", () => {
  const o = observe();
  const before = snap(o);
  const u = applyFetch(o, at("5m", 1), ok(0.002, { liquidityUsd: 1, marketCap: 1, volumeH1: 1 }));
  assert.equal(snap(u), before);
  assert.equal(u.outcomes["5m"]!.status, "OK");
  assert.equal(u.outcomes["5m"]!.decisionReturnPct, 100);
});

test("C: the +24h update changes no snapshot field", () => {
  let o = observe();
  const before = snap(o);
  for (const { key } of CHECKPOINTS) o = applyFetch(o, at(key, 1), ok(0.0005));
  assert.equal(snap(o), before);
  assert.equal(o.outcomes["24h"]!.decisionReturnPct, -50);
  assert.equal(o.snapshot.market.priceUsd, 0.001, "T0 price never overwritten by a later one");
  // Any tampering with the snapshot is refused.
  const tampered = { ...o, snapshot: { ...o.snapshot, market: { ...o.snapshot.market, priceUsd: 0.0005 } } };
  assert.throws(() => applyFetch(tampered, at("24h", 2), ok(0.0005)), /changed after capture/);
});

test("D: a future checkpoint is NOT_DUE and is not filled", () => {
  const o = observe();
  assert.equal(checkpointState(o, "15m", at("5m", 1)), "NOT_DUE");
  const u = applyFetch(o, at("5m", 1), ok(0.002));
  assert.equal(u.outcomes["15m"], undefined);
  assert.deepEqual(dueCheckpoints(observe(), T0 + MIN), []);
});

test("E: an already filled checkpoint is idempotent", () => {
  const o = applyFetch(observe(), at("15m", 1), ok(0.002));
  const again = applyFetch(o, at("15m", 3), ok(0.009));
  assert.deepEqual(again.outcomes["15m"], o.outcomes["15m"]);
  assert.equal(checkpointState(again, "15m", at("15m", 4)), "FINAL");
});

test("F: provider error → no -100 %, no price; retried while the window is open", () => {
  const o = applyFetch(observe(), at("1h", 1), { status: "PROVIDER_ERROR", error: "HTTP 429" });
  const c = o.outcomes["1h"]!;
  assert.deepEqual([c.status, c.priceUsd, c.decisionReturnPct, c.attempts], ["PROVIDER_ERROR", null, null, 1]);
  const retried = applyFetch(o, at("1h", 10), ok(0.0015));
  assert.deepEqual([retried.outcomes["1h"]!.status, retried.outcomes["1h"]!.decisionReturnPct, retried.outcomes["1h"]!.attempts], ["OK", 50, 2]);
});

test("G: pair absent from the provider response → UNAVAILABLE, no -100 %", () => {
  const c = applyFetch(observe(), at("3h", 1), { status: "UNAVAILABLE" }).outcomes["3h"]!;
  assert.deepEqual([c.status, c.priceUsd, c.decisionReturnPct], ["UNAVAILABLE", null, null]);
});

test("H: T0 price absent → return unknown, never NaN", () => {
  const o = observe(pair({ priceUsd: null }));
  const c = applyFetch(o, at("5m", 1), ok(0.002)).outcomes["5m"]!;
  assert.equal(c.status, "OK");
  assert.equal(c.decisionReturnPct, null, "the decision price here is the (absent) pair price too");
  assert.equal(c.marketReturnPct, null);
  assert.ok(c.note!.includes("inconnu"));
  for (const [a, b] of [[null, 1], [0, 1], [1, null], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]] as const) assert.equal(returnPct(a, b), null);
});

test("I: checkpoint price absent → return unknown", () => {
  const c = applyFetch(observe(), at("30m", 1), ok(null)).outcomes["30m"]!;
  assert.deepEqual([c.status, c.priceUsd, c.decisionReturnPct], ["OK", null, null]);
});

test("J: observedAt / delay are distinct from the target time; a passed window becomes MISSED", () => {
  const c = applyFetch(observe(), at("15m", 2), ok(0.002)).outcomes["15m"]!;
  assert.equal(c.targetAt, at("15m"));
  assert.equal(c.observedAt, at("15m", 2));
  assert.equal(c.delayMs, 2 * MIN);
  // First update only at +2h: 5m, 15m, 30m windows have passed → MISSED; 1h is filled with its real delay.
  const late = applyFetch(observe(), T0 + 120 * MIN, ok(0.002));
  assert.deepEqual(["5m", "15m", "30m"].map((k) => late.outcomes[k as CheckpointKey]!.status), ["MISSED", "MISSED", "MISSED"]);
  assert.ok(["5m", "15m", "30m"].every((k) => late.outcomes[k as CheckpointKey]!.decisionReturnPct === null));
  assert.equal(late.outcomes["1h"]!.delayMs, 60 * MIN);
});

test("K: same mint with two pairs → each observation follows its own T0 pair, no substitution", () => {
  const a = observe(pair({ pairAddress: "PAIR_A" }));
  const b = observe(pair({ pairAddress: "PAIR_B", priceUsd: 0.002 }));
  assert.notEqual(a.snapshot.observationId, b.snapshot.observationId);
  assert.throws(() => applyFetch(a, at("5m", 1), ok(0.003, { pairAddress: "PAIR_B" })), /no silent substitution/);
  assert.equal(applyFetch(b, at("5m", 1), ok(0.003, { pairAddress: "PAIR_B" })).outcomes["5m"]!.decisionReturnPct, 50);
});

test("L: re-running capture does not duplicate an observation; persistence round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "outcomes-"));
  try {
    const first = addObservations(loadStore(dir), [observe(), observe(pair({ pairAddress: "PAIR_B" }))]);
    saveStore(first.store, dir);
    const second = addObservations(loadStore(dir), [observe(), observe(pair({ pairAddress: "PAIR_B" }))]);
    assert.deepEqual([first.added, second.added, second.skipped, second.store.observations.length], [2, 0, 2, 2]);
    const updated = loadStore(dir).observations.map((o) => applyFetch(o, at("5m", 1), ok(0.002, { pairAddress: o.snapshot.identity.pairAddress })));
    saveStore(replaceOutcomes(loadStore(dir), updated), dir);
    const back = loadStore(dir);
    assert.equal(back.observations[0].outcomes["5m"]!.status, "OK");
    assert.equal(snap(back.observations[0]), snap(observe()), "snapshot unchanged on disk");
    // A modified snapshot is refused by replaceOutcomes.
    const bad = { ...updated[0], snapshot: { ...updated[0].snapshot, capturedAt: 1 } };
    assert.throws(() => replaceOutcomes(back, [bad]), /changed: refused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── report / export ───────────────────────────────────────────────────────

const clean = (t: string) => assert.ok(!/NaN|Infinity|undefined|\[object Object\]/.test(t), t);

test("report: empty dataset", () => {
  const t = formatReport([], T0);
  clean(t);
  assert.ok(t.includes("TOTAL OBSERVATIONS: 0"));
});

test("report: one observation, partial checkpoints, provider failure, UNKNOWN price", () => {
  let o = observe();
  o = applyFetch(o, at("5m", 1), ok(0.0012));
  o = applyFetch(o, at("15m", 1), { status: "PROVIDER_ERROR", error: "timeout" });
  const noPrice = applyFetch(observe(pair({ pairAddress: "PAIR_N", priceUsd: null })), at("5m", 1), ok(0.002, { pairAddress: "PAIR_N" }));
  const t = formatReport([o, noPrice], at("15m", 2));
  clean(t);
  assert.ok(t.includes("TOTAL OBSERVATIONS: 2"));
  assert.ok(t.includes("5m: 2/2"));
  assert.ok(t.includes("15m: 0/2 · UNAVAILABLE 0 · PROVIDER_ERROR 1"));
  assert.ok(t.includes("1 observation(s) sans prix T0"));
  assert.ok(t.includes("n=1 · moyenne +20.0 %"));
});

test("report: several decisions, observed path metrics, CSV export", () => {
  const strong = pair();
  const weak = pair({ pairAddress: "PAIR_W", tokenAddress: "MINT_W", volumeM5: 10, volumeH1: 50, buysM5: 0, sellsM5: 1, buysH1: 1, sellsH1: 5, liquidityUsd: 2_000, marketCap: 2_500, fdv: 2_500, priceChangeM5: 0, priceChangeH1: 0, priceChangeH6: 0 });
  let a = observe(strong);
  let b = observe(weak);
  assert.notEqual(a.snapshot.final.decision, b.snapshot.final.decision);
  for (const [key, pa, pb] of [["5m", 0.0011, 0.0009], ["1h", 0.0005, 0.0012], ["24h", 0.002, 0.0001]] as const) {
    a = applyFetch(a, at(key, 1), ok(pa));
    b = applyFetch(b, at(key, 1), ok(pb, { pairAddress: "PAIR_W" }));
  }
  const p = observedPath(a);
  assert.deepEqual([Math.round(p.maxObservedReturnPct!), Math.round(p.minObservedReturnPct!), p.observedPoints], [100, -50, 3]);
  const t = formatReport([a, b], at("24h", 5));
  clean(t);
  assert.ok(t.includes(`${a.snapshot.final.decision} (1 observation(s))`));
  assert.ok(t.includes("pas un vrai ATH / drawdown"));
  const csv = toCsv(exportRows([a, b]));
  clean(csv);
  assert.equal(csv.split("\n").length, 3);
  assert.ok(csv.split("\n")[0].includes("opportunity,dexRisk,dexQuality,dexConfidence"));
});

// ─── no impact on the scanner ──────────────────────────────────────────────

test("capturing never changes the scanner's results", () => {
  const p = pair();
  const score = scorePair(p, T0);
  const before = JSON.stringify(score);
  const fa = assessToken({ score });
  const faBefore = JSON.stringify(fa);
  let o = buildObservation({ pair: p, score, assessment: fa, timeline: { ...step2Timeline(T0), step3StartedAt: T0, step3CompletedAt: T0 }, decisionMarket: okDecisionMarket(p, T0), candidate: true, onchain: null, step3Status: "FAILED", wallets: null, step4Status: "NOT_RUN" });
  o = applyFetch(o, at("5m", 1), ok(0.5));
  assert.equal(JSON.stringify(score), before);
  assert.equal(JSON.stringify(fa), faBefore);
  assert.equal(assessToken({ score: scorePair(p, T0) }).decision, fa.decision);
  assert.equal(o.snapshot.funnel.step3Status, "FAILED");
});
