import { test } from "node:test";
import assert from "node:assert/strict";
import { community, copyTrading, marketMaking, measure, organic, planted, PLANTS, rate, runPipeline, seeds, semiReal } from "./helpers/benchmark.ts";
import { withConfig } from "../src/social/coordination/index.ts";

/**
 * Phase 5D-0/5D-1 acceptance benchmark. SYNTHETIC and semi-synthetic data only, fixed seeds, no network.
 * These numbers describe how the statistical procedure behaves when the truth is known by construction. They are NOT a
 * real-world rate of manipulation and they validate nothing about any real token.
 */

const NULLS: [string, (s: number) => ReturnType<typeof organic>][] = [
  ["organic, independent, hot", (s) => organic(s, { mean: 8 })],
  ["organic, independent, spread", (s) => organic(s, { mean: 35 })],
  ["organic, arrival-amount-exit correlated, hot", (s) => organic(s, { mean: 12, correlated: true })],
  ["organic, arrival-amount-exit correlated, spread", (s) => organic(s, { mean: 35, correlated: true })],
  ["copy-trading", (s) => copyTrading(s)],
  ["market making + arbitrage", (s) => marketMaking(s)],
  ["semi-real A (real launch, independent funding)", (s) => semiReal("A", s, "null")],
  ["semi-real B (real launch, independent funding)", (s) => semiReal("B", s, "null")],
];
const N = 100;

test("false positives: no regime flags a group systematically (family-wise rate at alpha=0.01, 100 seeds each)", () => {
  for (const [label, make] of NULLS) {
    const r = measure(seeds(N).map(make));
    assert.equal(r.hypotheses, 0, `${label}: hypotheses are off`);
    assert.ok(r.inferred === N, `${label}: inference ran on every launch (${r.inferred})`);
    assert.ok(r.flagged <= 4, `${label}: ${r.flagged}/${N} launches have a significant group (limit 4, expected ≈1)`);
  }
});

test("false positives at a looser level (alpha=0.05) stay near 5 %", () => {
  for (const [label, make] of NULLS) {
    const r = measure(seeds(N).map(make), { alpha: 0.05 });
    assert.ok(r.flagged <= 10, `${label}: ${r.flagged}/${N} at alpha 0.05 (limit 10)`);
  }
});

test("calibration: the smallest adjusted p per null launch is never below its nominal share (pooled over all null regimes)", () => {
  const pooled: number[] = [];
  for (const [, make] of NULLS) pooled.push(...measure(seeds(N, 1000).map(make)).minP);
  const share = (t: number) => pooled.filter((p) => p <= t).length / pooled.length;
  assert.ok(share(0.01) <= 0.03, `P(min p ≤ 0.01) = ${share(0.01)}`);
  assert.ok(share(0.05) <= 0.10, `P(min p ≤ 0.05) = ${share(0.05)}`);
  assert.ok(share(0.25) <= 0.35, `P(min p ≤ 0.25) = ${share(0.25)}`);
});

test("the old failure mode is gone: arrival-time/amount/exit correlation no longer opens a systematic signal", () => {
  // the 5C procedure flagged 100/100 such launches (audit Q3); the 5D procedure holds each wallet's behaviour fixed
  for (const mean of [12, 35]) {
    const r = measure(seeds(150, 5000).map((s) => organic(s, { mean, correlated: true })));
    assert.ok(r.flagged <= 5, `${r.flagged}/150 flagged`);
  }
});

test("power: planted coordination with a shared funder is detected; small groups are not claimed", () => {
  const rows: Record<string, number> = {};
  for (const k of [3, 5, 8, 12]) {
    for (const [name, fam] of Object.entries(PLANTS)) {
      const r = measure(seeds(60).map((s) => planted(s, k, fam)));
      rows[`${name} k=${k}`] = rate(r.detectedPlanted, r.launches);
      assert.equal(r.hypotheses, 0);
    }
  }
  for (const name of ["F+T+A+E", "F+T+A", "F+A+E"]) {
    assert.ok(rows[`${name} k=8`]! >= 0.8, `${name} k=8: ${rows[`${name} k=8`]}`);
    assert.ok(rows[`${name} k=12`]! >= 0.8, `${name} k=12: ${rows[`${name} k=12`]}`);
  }
  // two families only (funding + timing): weaker, documented
  assert.ok(rows["F+T k=8"]! >= 0.7 && rows["F+T k=12"]! >= 0.7, `F+T: ${rows["F+T k=8"]} ${rows["F+T k=12"]}`);
  for (const name of ["F+T+A+E", "F+T+A", "F+A+E"]) assert.ok(rows[`${name} k=5`]! >= 0.6, `${name} k=5: ${rows[`${name} k=5`]}`);
  for (const name of ["F+T+A+E", "F+T+A", "F+A+E", "F+T"]) assert.ok(rows[`${name} k=3`]! <= 0.35, `k=3 is under-powered and is not claimed: ${rows[`${name} k=3`]}`);
});

test("documented limit: coordination WITHOUT a shared funding link cannot be tested and is never reported as significant", () => {
  for (const k of [5, 8, 12]) {
    const r = measure(seeds(60).map((s) => planted(s, k, PLANTS["T+A+E (no funding)"]!)));
    assert.equal(r.flagged, 0);
    assert.ok(r.groupsReported > 0, "the behavioural group is still described (indication only)");
  }
  // funding alone on random wallets (no behavioural similarity) is not coordination evidence either
  const r = measure(seeds(60).map((s) => semiReal("A", s, "cluster", ["1", "2", "3"])));
  assert.equal(r.flagged, 0);
});

test("semi-real: funding planted on four real same-slot wallets of B is detected; the real launch of A stays quiet", () => {
  const b = measure(seeds(60).map((s) => semiReal("B", s, "cluster", ["7unxwW", "2cPTXv", "ARnjeA", "9tiLW3"])));
  assert.ok(b.detectedPlanted / b.launches >= 0.8, `B: ${b.detectedPlanted}/${b.launches}`);
});

test("sensitivity to parameters: false positives stay bounded and power stays useful across settings", () => {
  const variants: [string, Parameters<typeof withConfig>[0]][] = [
    ["alpha 0.05", { alpha: 0.05 }],
    ["permutations 100", { cluster: { permutations: 100 } }],
    ["permutations 1000", { cluster: { permutations: 1000 } }],
    ["amount tolerance 0.02", { cluster: { amountTolerance: 0.02 } }],
    ["amount tolerance 0.10", { cluster: { amountTolerance: 0.1 } }],
    ["sync slots 0", { launch: { syncSlots: 0 } }],
    ["sync slots 3", { launch: { syncSlots: 3 } }],
    ["exit sync 1", { cluster: { exitSyncSlots: 1 } }],
    ["exit sync 5", { cluster: { exitSyncSlots: 5 } }],
    ["min known wallets 20", { inference: { minKnownWallets: 20 } }],
    ["3 families per pair", { cluster: { minFamiliesForMulti: 3 } }],
  ];
  for (const [label, over] of variants) {
    const lim = over?.alpha === 0.05 ? 10 : 4;
    const nul = measure(seeds(N).map((s) => organic(s, { mean: 35, correlated: true })), over);
    const pl = measure(seeds(60).map((s) => planted(s, 8, PLANTS["F+T+A+E"]!)), over);
    assert.ok(nul.flagged <= lim, `${label}: ${nul.flagged} false positives`);
    assert.ok(pl.detectedPlanted / pl.launches >= 0.6, `${label}: power ${pl.detectedPlanted}/${pl.launches}`);
  }
});

test("an alpha the permutations cannot reach is reported as UNKNOWN, not silently as 'nothing found'", () => {
  const sc = planted(1, 8, PLANTS["F+T+A+E"]!);
  const r = runPipeline(sc, { alpha: 0.001, cluster: { permutations: 500 } });
  assert.equal(r.cluster.inference.status, "unknown");
  assert.match(r.cluster.inference.reason!, /ne permettent pas d'atteindre le niveau alpha/);
  assert.ok(r.cluster.groups.every((g) => g.adjustedP === null && !g.significant));
  const ok = runPipeline(sc, { alpha: 0.001, cluster: { permutations: 2000 } });
  assert.equal(ok.cluster.inference.status, "ok");
});

test("robustness to incomplete history: false positives stay at zero, power degrades gracefully, UNKNOWN replaces zeros", () => {
  const nullF = (s: number) => organic(s, { mean: 35, correlated: true });
  const plF = (s: number) => planted(s, 8, PLANTS["F+T+A+E"]!);
  const power: number[] = [];
  for (const f of [0, 0.25, 0.5, 0.75]) {
    const nul = measure(seeds(N).map(nullF), {}, f);
    const pl = measure(seeds(60).map(plF), {}, f);
    assert.ok(nul.flagged <= 4, `degrade ${f}: ${nul.flagged} false positives`);
    power.push(pl.detectedPlanted / pl.launches);
    if (f >= 0.75) {
      assert.equal(pl.inferred, 0, "with 75 % of histories partial the inference is UNKNOWN on every launch");
      assert.equal(pl.flagged, 0);
    }
  }
  assert.ok(power[0]! >= 0.85 && power[1]! >= 0.75, `power ${power.join(" ")}`);
  for (let i = 1; i < power.length; i++) assert.ok(power[i]! <= power[i - 1]! + 0.1, `power should not grow as data disappears: ${power.join(" ")}`);
  // when the inference is UNKNOWN there is no p-value anywhere, and no 'zero' either
  const sc = plF(3);
  const degraded = new Set(sc.wallets.filter((_, i) => i % 4 !== 0));
  const r = runPipeline(sc, {}, degraded);
  assert.equal(r.cluster.inference.status, "unknown");
  assert.ok(r.cluster.groups.every((g) => g.adjustedP === null && g.inference === "unknown"));
  assert.equal(r.funding.knownCount + r.funding.unknownCount, r.funding.wallets.length);
});

test("descriptive wash measures: market makers show the balanced motif, organic markets do not, nothing is called anomalous", () => {
  let mm = 0;
  let org = 0;
  for (const s of seeds(30)) {
    if (runPipeline(marketMaking(s)).wash.motifWallets.length >= 3) mm++;
    if (runPipeline(organic(s, { mean: 35 })).wash.motifWallets.length > 0) org++;
  }
  assert.equal(mm, 30, "the three market makers are described as a motif (a descriptive pointer, not a verdict)");
  assert.equal(org, 0);
  assert.ok(runPipeline(marketMaking(1)).wash.flags.every((f) => !/anormal|manipul|fraude/i.test(f)));
});

test("confounder: friend groups funded by a founder and buying together are described with their counter-explanations; no hypothesis, and the significance rate is only reported", () => {
  const r = measure(seeds(60).map((s) => community(s)));
  assert.equal(r.hypotheses, 0);
  // this procedure is conservative when behaviour is dense (chance links merge groups in the permutations): most communities are NOT significant
  assert.ok(r.flagged / r.launches <= 0.5, `communities flagged ${r.flagged}/${r.launches}`);
  const p = runPipeline(community(1));
  const withFunding = p.cluster.groups.filter((x) => x.families.includes("funding"));
  assert.ok(withFunding.length > 0);
  assert.ok(withFunding.every((x) => x.counterExplanations.some((c) => c.includes("amis") || c.includes("communauté"))));
});

test("the benchmark is deterministic (same seeds, same numbers)", () => {
  const a = measure(seeds(20).map((s) => organic(s, { mean: 12, correlated: true })));
  const b = measure(seeds(20).map((s) => organic(s, { mean: 12, correlated: true })));
  assert.deepEqual(a, b);
});
