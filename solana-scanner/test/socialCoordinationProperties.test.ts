import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCoordination, recordCoordinationEvidence, extractCoordinationFeatures, scoreCoordinationRiskDraft, FAMILIES, normalizeTx, withConfig } from "../src/social/coordination/index.ts";
import type { CoordinationResult } from "../src/social/coordination/index.ts";
import { EvidenceLedger } from "../src/social/ledger.ts";
import { BASE_SLOT, MINT, SOL, addr, cov, mapProvider, prng, solTransferTx, swapTx } from "./helpers/coordination.ts";

/** Random but reproducible market: traders pick sides, sizes and times at random; funding sources are drawn from a small pool. */
function randomScenario(seed: number) {
  const rng = prng(seed);
  const nTraders = 3 + Math.floor(rng() * 40);
  const traders = Array.from({ length: nTraders }, (_, i) => addr(`p${seed}-${i}`));
  const funders = Array.from({ length: 1 + Math.floor(rng() * 6) }, (_, i) => addr(`pf${seed}-${i}`));
  const raws = [];
  const n = 20 + Math.floor(rng() * 150);
  for (let i = 0; i < n; i++) {
    const w = traders[Math.floor(rng() * nTraders)]!;
    const q = BigInt(Math.floor(1e6 + rng() * 5e9));
    raws.push(swapTx({ n: seed * 1000 + i, slot: BASE_SLOT + Math.floor(rng() * rng() * 400), trader: w, side: rng() < 0.65 ? "buy" : "sell", base: q * 100n + 1n, quote: q }));
  }
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  traders.forEach((w, i) => {
    if (rng() < 0.9) map[w] = [{ from: funders[Math.floor(rng() * funders.length)]!, lamports: BigInt(Math.floor(1e8 + rng() * 3e9)), slot: Math.floor(rng() * 1000), n: 500_000 + seed * 100 + i }];
  });
  for (const f of funders) map[f] = rng() < 0.5 ? [] : [{ from: addr(`root${seed}`), lamports: 50n * SOL, slot: 1, n: 600_000 + seed }];
  return { txs: raws.map(normalizeTx), provider: mapProvider(map), traders };
}

const input = (s: ReturnType<typeof randomScenario>, over = {}) => ({ mint: MINT, creator: null, supplyRaw: 10n ** 15n, txs: s.txs, coverage: cov(), provider: s.provider, ...over });
const shuffle = <T,>(a: T[], rng: () => number): T[] => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [x[i], x[j]] = [x[j]!, x[i]!];
  }
  return x;
};

function invariants(r: CoordinationResult, label: string) {
  const cohort = new Set(r.launch.cohort.map((m) => m.wallet));
  assert.ok(r.launch.cohort.length <= 50, label);
  assert.equal(cohort.size, r.launch.cohort.length, `${label}: cohort wallets are distinct`);
  assert.ok(r.funding.wallets.length <= 50, label);
  for (const g of r.cluster.groups) {
    assert.ok(g.wallets.every((w) => cohort.has(w)), `${label}: group wallets are cohort wallets`);
    assert.ok(g.families.every((f) => FAMILIES.includes(f)), label);
    if (g.strength === "multi_signal") assert.ok(g.families.length >= 2, label);
    if (g.hypothesisEligible) {
      assert.ok(g.families.length >= 3 && g.families.some((f) => f !== "funding" && f !== "timing"), `${label}: hypothesis needs 3 families incl. one beyond funding/timing`);
    }
    assert.ok(g.counterExplanations.length > 0, label);
    assert.ok(g.wallets.length >= 2, label);
  }
  const w = r.wash;
  if (w.roundTripShare !== null) assert.ok(w.roundTripShare >= 0 && w.roundTripShare <= 1.000001, `${label}: share ${w.roundTripShare}`);
  if (w.motifVolumeShare !== null) assert.ok(w.motifVolumeShare >= 0 && w.motifVolumeShare <= 1.000001, label);
  assert.ok(w.judgedQuote + w.excludedQuote === w.grossQuote, `${label}: volume split adds up`);
  assert.equal(r.launch.sync.calibrated, false, label);
  const inf = r.cluster.inference;
  assert.ok(["ok", "unknown", "not_applicable"].includes(inf.status), label);
  if (inf.status !== "ok") assert.ok(inf.reason, `${label}: a non-ok inference says why`);
  for (const g of r.cluster.groups) {
    if (g.adjustedP !== null) assert.ok(inf.status === "ok" && g.adjustedP > 0 && g.adjustedP <= 1, label);
    if (inf.status !== "ok") assert.ok(g.adjustedP === null && !g.significant, `${label}: no p-value without a valid inference`);
    assert.equal(g.hypothesisEligible, false, `${label}: hypotheses are off by default`);
  }
  assert.ok(r.funding.knownCount + r.funding.unknownCount === r.funding.wallets.length, label);
  assert.ok(r.limits.some((l) => l.includes("aucune conclusion de fraude")), label);
  for (const s of r.funding.shared) {
    if (s.entity || s.probableService) assert.equal(s.discriminating, false, label);
  }
}

test("property: invariants hold on 60 random markets (and recording in the ledger never violates its rules)", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = randomScenario(seed);
    const r = analyzeCoordination(input(s));
    invariants(r, `seed ${seed}`);
    const ledger = new EvidenceLedger();
    recordCoordinationEvidence({ ledger, result: r, observedAt: "2026-10-09T12:00:00Z" });
    for (const e of ledger.all()) {
      if (e.status === "HYPOTHESIS") assert.ok(r.cluster.groups.some((g) => g.hypothesisEligible), `seed ${seed}`);
      if (e.derivation === "estimated") assert.notEqual(e.status, "FACT");
    }
    const score = scoreCoordinationRiskDraft(extractCoordinationFeatures(r));
    if (score.score !== null) assert.ok(score.score >= 0 && score.score <= 100);
  }
});

test("property: shuffling the transactions never changes the result", () => {
  const rng = prng(99);
  for (let seed = 100; seed < 120; seed++) {
    const s = randomScenario(seed);
    const a = analyzeCoordination(input(s));
    const b = analyzeCoordination(input({ ...s, txs: shuffle(s.txs, rng) }));
    const view = (r: CoordinationResult) => JSON.stringify([r.launch.cohort.map((m) => [m.wallet, m.firstBuySlot]), r.cluster.groups.map((g) => [g.wallets, g.families]), r.funding.shared.map((x) => [x.source, x.wallets]), r.wash.roundTripShare, r.wash.motifWallets.length, r.cluster.inference.components.map((c) => [c.size, c.adjustedP]), r.launch.sync.observedPairs]);
    assert.equal(view(a), view(b), `seed ${seed}`);
  }
});

test("property: lowering the wallet limit only removes wallets from the tracing, never changes the cohort", () => {
  for (let seed = 200; seed < 215; seed++) {
    const s = randomScenario(seed);
    const full = analyzeCoordination(input(s));
    const small = analyzeCoordination(input(s, { cfg: withConfig({ funding: { maxWallets: 3 } }) }));
    assert.deepEqual(small.launch.cohort.map((m) => m.wallet), full.launch.cohort.map((m) => m.wallet));
    assert.ok(small.funding.wallets.length <= 3);
    assert.equal(small.funding.wallets.length + small.funding.notTraced.length, full.launch.cohort.length);
  }
});

test("scope: reading only the oldest transactions of a longer history is declared everywhere", () => {
  const s = randomScenario(7);
  const r = analyzeCoordination(input(s, { coverage: cov({ signaturesRead: 5000, transactionsRead: 250 }) }));
  assert.equal(r.scopeLimited, true);
  assert.ok(r.limits.some((l) => l.includes("250 transactions les plus anciennes sur 5000")));
  assert.ok(r.wash.notes.some((n) => n.includes("transactions les plus anciennes")));
  const ledger = new EvidenceLedger();
  const ids = recordCoordinationEvidence({ ledger, result: r, observedAt: "2026-10-09T12:00:00Z" });
  assert.ok(ledger.all().some((e) => e.type === "data_gap" && e.summary.includes("Analyse limitée")));
  if (ids.wash) assert.equal(ledger.get(ids.wash)!.derivation, "estimated");
  assert.equal(extractCoordinationFeatures(r).dataComplete, false);
  assert.equal(analyzeCoordination(input(s)).scopeLimited, false);
});

test("edge: no transactions, a single trader, null block times, huge amounts and zero-value swaps do not crash", () => {
  const empty = analyzeCoordination({ mint: MINT, creator: null, supplyRaw: null, txs: [], coverage: cov({ signaturesRead: 0, transactionsRead: 0 }), provider: () => null });
  assert.equal(empty.swaps.length, 0);
  assert.equal(empty.wash.roundTripShare, null);
  const ledger = new EvidenceLedger();
  assert.doesNotThrow(() => recordCoordinationEvidence({ ledger, result: empty, observedAt: "2026-10-09T12:00:00Z" }));

  const one = swapTx({ n: 1, slot: BASE_SLOT, trader: addr(1), side: "buy", base: 10n ** 14n, quote: 10_000n * SOL });
  one.blockTime = null;
  const r1 = analyzeCoordination({ mint: MINT, creator: null, supplyRaw: 10n ** 15n, txs: [normalizeTx(one)], coverage: cov(), provider: () => null });
  assert.equal(r1.launch.cohort.length, 1);
  assert.equal(r1.launch.cohortSupplyShare, 0.1);
  assert.equal(extractCoordinationFeatures(r1).sharedFundingShare, null);

  const zero = swapTx({ n: 2, slot: BASE_SLOT, trader: addr(2), side: "buy", base: 1n, quote: 0n });
  assert.doesNotThrow(() => analyzeCoordination({ mint: MINT, creator: null, supplyRaw: 1n, txs: [normalizeTx(zero), normalizeTx(solTransferTx({ n: 3, slot: 1, from: addr(1), to: addr(2), lamports: SOL }))], coverage: cov(), provider: () => null }));
});
