import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { assessToken } from "../src/final/assessment.ts";
import { archiveLegacyStore, fileOf, LegacyDatasetError, loadStore } from "../src/outcomes/store.ts";
import { applyFetch, buildObservation, checkpointState, decisionMarketFrom, hashSnapshot, SCHEMA_VERSION, targetOf } from "../src/outcomes/tracker.ts";
import type { DecisionMarket, Observation, Timeline } from "../src/outcomes/tracker.ts";
import { scorePair } from "../src/scoring/score.ts";
import { okDecisionMarket, step2Timeline } from "./helpers/outcomes.ts";

/** Schema v2: outcomes anchored on decisionAvailableAt, priced from the decision-time market. Offline. */

const T0 = Date.UTC(2026, 9, 5, 21, 49, 46);
const S = 1000;
const MIN = 60_000;
const pair = (o: Partial<NormalizedPair> = {}): NormalizedPair => ({
  chainId: "solana", dexId: "pumpswap", url: null, pairAddress: "PAIR_A", tokenAddress: "MINT_1", tokenName: "Fixture", tokenSymbol: "FIX", quoteSymbol: "SOL",
  priceUsd: 0.001, marketCap: 400_000, fdv: 400_000, liquidityUsd: 60_000, volumeM5: 9_000, volumeH1: 70_000, volumeH6: 200_000, volumeH24: 400_000,
  buysM5: 40, sellsM5: 20, buysH1: 500, sellsH1: 300, priceChangeM5: 4, priceChangeH1: 30, priceChangeH6: 60, pairCreatedAt: T0 - 4 * 60 * MIN, ...o,
});
/** A slow candidate: Step 3 then Step 4 finish ~7 min after the DEX scan (the 21:49 → 21:56 case). */
const slow: Timeline = {
  captureStartedAt: T0 - 20 * S, marketObservedAt: T0, step2CompletedAt: T0 + 1 * S,
  step3StartedAt: T0 + 2 * S, step3CompletedAt: T0 + 20 * S, step4StartedAt: T0 + 21 * S, step4CompletedAt: T0 + 7 * MIN,
  assessmentCompletedAt: T0 + 7 * MIN + 1 * S, decisionAvailableAt: T0 + 7 * MIN + 1 * S, snapshotFinalizedAt: T0 + 7 * MIN + 3 * S,
};
const DEC = slow.decisionAvailableAt;
const ok = (price: number | null, o: Partial<NormalizedPair> = {}) => ({ status: "OK" as const, pair: pair({ priceUsd: price, ...o }) });
const build = (o: { p?: NormalizedPair; timeline?: Timeline; dm?: DecisionMarket; step3?: "NOT_RUN" | "COMPLETE"; step4?: "NOT_RUN" | "COMPLETE" } = {}): Observation => {
  const p = o.p ?? pair();
  const score = scorePair(p, T0);
  return buildObservation({
    pair: p, score, assessment: assessToken({ score }), timeline: o.timeline ?? slow, decisionMarket: o.dm ?? okDecisionMarket(p, DEC + 2 * S, 0.0015),
    candidate: true, onchain: null, step3Status: o.step3 ?? "COMPLETE", wallets: null, step4Status: o.step4 ?? "COMPLETE",
  });
};

test("A: a slow candidate's decision comes after the market observation", () => {
  const o = build();
  assert.ok(o.snapshot.timeline.marketObservedAt < o.snapshot.timeline.decisionAvailableAt);
  assert.equal(o.snapshot.timeline.decisionAvailableAt - o.snapshot.timeline.marketObservedAt, 7 * MIN + 1 * S);
  assert.equal(o.snapshot.capturedAt, T0, "capturedAt stays the market T0, never the decision time");
  assert.equal(o.snapshot.schemaVersion, SCHEMA_VERSION);
});

test("B / C: the decision is never earlier than Step 3 or Step 4 completion", () => {
  const o = build();
  assert.ok(o.snapshot.timeline.decisionAvailableAt >= o.snapshot.timeline.step4CompletedAt!);
  assert.ok(o.snapshot.timeline.decisionAvailableAt >= o.snapshot.timeline.step3CompletedAt!);
  assert.throws(() => build({ timeline: { ...slow, decisionAvailableAt: slow.step4CompletedAt! - S, assessmentCompletedAt: slow.step4CompletedAt! - S } }), /antérieur à une donnée utilisée/);
  assert.throws(() => build({ timeline: { ...slow, step4StartedAt: null, step4CompletedAt: null, decisionAvailableAt: slow.step3CompletedAt! - S, assessmentCompletedAt: slow.step3CompletedAt! - S }, step4: "NOT_RUN" }), /antérieur à une donnée utilisée/);
  assert.throws(() => build({ dm: okDecisionMarket(pair(), DEC - S) }), /decisionMarket observé avant la décision/);
});

test("D: Step-2-only observations have a valid decisionAvailableAt and no invented engine times", () => {
  const p = pair();
  const t = step2Timeline(T0, 40, 900);
  const o = build({ timeline: t, dm: okDecisionMarket(p, T0 + 40, 0.001), step3: "NOT_RUN", step4: "NOT_RUN" });
  assert.equal(o.snapshot.timeline.decisionAvailableAt, T0 + 40);
  assert.deepEqual([o.snapshot.timeline.step3StartedAt, o.snapshot.timeline.step3CompletedAt, o.snapshot.timeline.step4StartedAt, o.snapshot.timeline.step4CompletedAt], [null, null, null, null]);
  assert.throws(() => build({ timeline: { ...t, step3StartedAt: T0 }, dm: okDecisionMarket(p, T0 + 40), step3: "NOT_RUN", step4: "NOT_RUN" }), /non exécuté mais horodaté/);
});

test("E: the +5m checkpoint is computed from decisionAvailableAt, not from the scan", () => {
  const o = build();
  assert.equal(targetOf(o.snapshot, "5m"), DEC + 5 * MIN);
  assert.equal(checkpointState(o, "5m", T0 + 6 * MIN), "NOT_DUE", "T0 + 6 min: due under the old scan anchor, not yet due now");
  assert.equal(checkpointState(o, "5m", DEC + 5 * MIN), "DUE");
  assert.equal(checkpointState(o, "5m", DEC + 14 * MIN), "DUE", "a 7-min capture no longer eats the 5m window");
  const c = applyFetch(o, DEC + 5 * MIN + 30 * S, ok(0.003)).outcomes["5m"]!;
  assert.deepEqual([c.targetAt, c.delayMs], [DEC + 5 * MIN, 30 * S]);
});

test("F: decisionReturnPct uses the decision-time price, marketReturnPct the T0 price", () => {
  const c = applyFetch(build(), DEC + 5 * MIN, ok(0.003)).outcomes["5m"]!;
  assert.equal(Math.round(c.decisionReturnPct!), 100, "0.0015 → 0.003");
  assert.equal(Math.round(c.marketReturnPct!), 200, "0.001 → 0.003");
});

test("G: changing the T0 price without changing the decision market leaves decisionReturnPct unchanged", () => {
  const a = applyFetch(build({ p: pair({ priceUsd: 0.001 }) }), DEC + 5 * MIN, ok(0.003)).outcomes["5m"]!;
  const b = applyFetch(build({ p: pair({ priceUsd: 0.0005 }) }), DEC + 5 * MIN, ok(0.003)).outcomes["5m"]!;
  assert.equal(a.decisionReturnPct, b.decisionReturnPct);
  assert.notEqual(a.marketReturnPct, b.marketReturnPct);
});

test("H: a failed decision-market fetch → decision return unknown, never -100 %, T0 price never reused", () => {
  const dm = decisionMarketFrom("PAIR_A", { status: "PROVIDER_ERROR", error: "HTTP 503" }, DEC + S);
  assert.deepEqual([dm.status, dm.priceUsd], ["PROVIDER_ERROR", null]);
  const c = applyFetch(build({ dm }), DEC + 5 * MIN, ok(0.0002)).outcomes["5m"]!;
  assert.equal(c.decisionReturnPct, null);
  assert.equal(Math.round(c.marketReturnPct!), -80);
  assert.ok(c.note!.includes("prix à la décision inconnu"));
  const gone = decisionMarketFrom("PAIR_A", { status: "UNAVAILABLE" }, DEC + S);
  assert.equal(applyFetch(build({ dm: gone }), DEC + 5 * MIN, ok(0.0002)).outcomes["5m"]!.decisionReturnPct, null);
});

test("I: a schema v1 dataset is never read as v2 (no invented decisionAvailableAt); archived untouched as legacy-v0", () => {
  const dir = mkdtempSync(join(tmpdir(), "outcomes-legacy-"));
  try {
    const legacy = JSON.stringify({ schemaVersion: 1, observations: [{ snapshot: { schemaVersion: 1, observationId: "M:P:1", capturedAt: T0 }, snapshotHash: "x", outcomes: {} }] });
    writeFileSync(fileOf(dir), legacy);
    assert.throws(() => loadStore(dir), (e: unknown) => e instanceof LegacyDatasetError && /archive-legacy/.test((e as Error).message));
    const dest = archiveLegacyStore(dir, new Date(Date.UTC(2026, 9, 5, 22, 0, 0)))!;
    assert.ok(dest.endsWith(join("backups", "observations-legacy-v0-20261005-220000.json")));
    assert.equal(readFileSync(dest, "utf8"), legacy, "archived byte for byte, no field added");
    assert.ok(!readFileSync(dest, "utf8").includes("decisionAvailableAt"));
    assert.ok(!existsSync(fileOf(dir)));
    assert.deepEqual(loadStore(dir), { schemaVersion: SCHEMA_VERSION, observations: [] });
    assert.equal(archiveLegacyStore(dir), null, "nothing legacy left");
    assert.equal(readdirSync(join(dir, "backups")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("J: snapshotHash covers the timeline and the decision market", () => {
  const o = build();
  const t = { ...o, snapshot: { ...o.snapshot, timeline: { ...o.snapshot.timeline, decisionAvailableAt: T0 } } };
  const m = { ...o, snapshot: { ...o.snapshot, decisionMarket: { ...o.snapshot.decisionMarket, priceUsd: 0.001 } } };
  assert.notEqual(hashSnapshot(t.snapshot), o.snapshotHash);
  assert.notEqual(hashSnapshot(m.snapshot), o.snapshotHash);
  assert.throws(() => applyFetch(t, DEC + 5 * MIN, ok(0.003)), /changed after capture/);
  assert.throws(() => applyFetch(m, DEC + 5 * MIN, ok(0.003)), /changed after capture/);
});

test("K: outcome updates never touch the timeline or the decision market", () => {
  let o = build();
  const before = JSON.stringify([o.snapshot.timeline, o.snapshot.decisionMarket]);
  for (const [m, price] of [[5, 0.002], [15, 0.001], [60, 0.004], [24 * 60, 0.0001]] as const) o = applyFetch(o, DEC + m * MIN + 10 * S, ok(price));
  assert.equal(JSON.stringify([o.snapshot.timeline, o.snapshot.decisionMarket]), before);
  assert.equal(o.snapshotHash, hashSnapshot(o.snapshot));
});

test("L: a decision-market fetch for another pair is rejected", () => {
  assert.throws(() => decisionMarketFrom("PAIR_A", ok(0.002, { pairAddress: "PAIR_B" }), DEC + S), /no silent substitution/);
  assert.equal(decisionMarketFrom("PAIR_A", ok(0.002), DEC + S).priceUsd, 0.002);
});
