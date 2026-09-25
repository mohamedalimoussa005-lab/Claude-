import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { SCORING_CONFIG } from "../src/scoring/config.ts";
import { ANOMALY } from "../src/scoring/quality.ts";
import { scorePair } from "../src/scoring/score.ts";
import type { PairScore } from "../src/scoring/score.ts";

const NOW = Date.UTC(2026, 8, 25, 18, 0, 0);
const minutesAgo = (m: number) => NOW - m * 60_000;

/**
 * Baseline: established, liquid pair with normal, two-sided activity
 * (~$100 average ticket, 55–60 % buys) and a moderate price rise.
 */
function pair(overrides: Partial<NormalizedPair> = {}): NormalizedPair {
  return {
    chainId: "solana",
    dexId: "raydium",
    url: null,
    pairAddress: "PAIR",
    tokenAddress: "TOKEN",
    tokenName: "Baseline",
    tokenSymbol: "BASE",
    quoteSymbol: "SOL",
    priceUsd: 0.0004,
    marketCap: 400_000,
    fdv: 400_000,
    liquidityUsd: 80_000,
    volumeM5: 15_000,
    volumeH1: 190_000,
    volumeH6: 700_000,
    volumeH24: 1_500_000,
    buysM5: 90,
    sellsM5: 70,
    buysH1: 1_000,
    sellsH1: 900,
    priceChangeM5: 2,
    priceChangeH1: 12,
    priceChangeH6: 30,
    pairCreatedAt: minutesAgo(8 * 60),
    ...overrides,
  };
}

const score = (o: Partial<NormalizedPair> = {}) => scorePair(pair(o), NOW);
const titles = (s: PairScore) => s.signals.anomalies.map((a) => a.title);
const deduction = (s: PairScore, key: string) => s.qualityDetail.deductions.find((d) => d.key === key)?.points ?? 0;
const riskOf = (s: PairScore, key: string) => s.riskFactors.find((f) => f.key === key)?.points ?? 0;
const item = (s: PairScore, cat: keyof PairScore["categories"], key: string) => s.categories[cat].items.find((i) => i.key === key)!;

function assertWellFormed(s: PairScore) {
  for (const v of [s.opportunity, s.risk, s.quality]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, String(v));
  assert.ok(["LOW", "MEDIUM", "HIGH"].includes(s.confidence.level));
  for (const d of s.qualityDetail.deductions) assert.ok(Number.isFinite(d.points) && d.points > 0);
  assert.equal(s.quality, Math.max(0, Math.round(100 - s.qualityDetail.deductions.reduce((a, d) => a + d.points, 0))));
}

test("1000 buys / 900 sells with normal activity: high quality, high confidence, no anomaly", () => {
  const s = score();
  assertWellFormed(s);
  assert.ok(s.quality >= 90, `quality ${s.quality}`);
  assert.equal(s.confidence.level, "HIGH");
  assert.deepEqual(s.signals.anomalies, []);
  assert.ok(s.signals.positive.length > 0);
  assert.equal(s.label, "MOMENTUM");
});

test("573 buys / 4 sells with tiny tickets: possible artificial activity, no excellent Opportunity", () => {
  // UTILITY-like: $0.2 average ticket on 1 h, 99 % buys on 5 min, price flat.
  const s = score({
    buysM5: 573,
    sellsM5: 4,
    volumeM5: 120,
    buysH1: 5_800,
    sellsH1: 200,
    volumeH1: 1_200,
    priceChangeM5: 0.3,
    priceChangeH1: 1.5,
  });
  assertWellFormed(s);
  assert.ok(titles(s).includes(ANOMALY.artificial), titles(s).join(", "));
  assert.ok(titles(s).includes(ANOMALY.imbalance));
  assert.ok(titles(s).includes(ANOMALY.divergence));
  assert.ok(!titles(s).some((t) => /bot/i.test(t)), "never concludes 'bot'");
  assert.ok(s.quality < 40, `quality ${s.quality}`);
  assert.equal(s.confidence.level, "LOW");
  // Many transactions no longer buy a strong Buy Pressure score.
  assert.ok(s.categories.buyPressure.points <= 6, `buy pressure ${s.categories.buyPressure.points}`);
  assert.ok(s.categories.buyPressure.points < score().categories.buyPressure.points);
  assert.ok(s.opportunity < 60, `opportunity ${s.opportunity}`);
  assert.ok(riskOf(s, "smallTicket") > 0);
  assert.ok(riskOf(s, "imbalance") > 0);
  assert.notEqual(s.label, "MOMENTUM");
});

test("a high buy ratio is not automatically positive", () => {
  const balanced = score({ buysH1: 1_200, sellsH1: 700 });
  const extreme = score({ buysH1: 1_880, sellsH1: 20 });
  assert.ok(item(extreme, "buyPressure", "h1").points < item(balanced, "buyPressure", "h1").points);
  assert.ok(deduction(extreme, "imbalanceH1") > 0);
  assert.equal(deduction(balanced, "imbalanceH1"), 0);
});

test("BACKPACA-like 1327 / 162 with heavy flow and flat price flags imbalance and divergence", () => {
  const s = score({
    buysM5: 1_327,
    sellsM5: 162,
    volumeM5: 29_000,
    buysH1: 20_214,
    sellsH1: 2_114,
    volumeH1: 476_000,
    liquidityUsd: 58_000,
    marketCap: 384_000,
    priceChangeM5: -2.9,
    priceChangeH1: -1.8,
    priceChangeH6: 397,
    pairCreatedAt: minutesAgo(140),
  });
  assertWellFormed(s);
  assert.ok(titles(s).includes(ANOMALY.imbalance));
  assert.ok(titles(s).includes(ANOMALY.divergence));
  assert.ok(s.quality < 60, `quality ${s.quality}`);
  assert.notEqual(s.confidence.level, "HIGH");
});

test("many transactions, buy-dominated, flat price: 'High transaction activity with limited price response'", () => {
  const s = score({ buysH1: 1_500, sellsH1: 600, priceChangeH1: 0.4, priceChangeM5: 0.1 });
  assertWellFormed(s);
  assert.ok(s.qualityDetail.divergenceH1.triggered);
  const a = s.signals.anomalies.find((x) => x.title === ANOMALY.divergence);
  assert.ok(a);
  assert.match(a.detail, /2,100 transactions/);
  assert.equal(riskOf(s, "divergence"), SCORING_CONFIG.risk.divergence);
  assert.match(item(s, "buyPressure", "h1").note ?? "", /sans réaction du prix/);
  // Same flow with a real price response: no divergence.
  assert.equal(score({ buysH1: 1_500, sellsH1: 600, priceChangeH1: 20 }).qualityDetail.divergenceH1.triggered, false);
});

test("volume/liquidity = 5×: mild, no anomaly", () => {
  const s = score({ volumeH1: 400_000 });
  assertWellFormed(s);
  assert.ok(deduction(s, "turnover") > 0 && deduction(s, "turnover") < 5);
  assert.ok(!titles(s).includes(ANOMALY.turnover));
  assert.equal(riskOf(s, "turnover"), 0);
  assert.equal(s.confidence.level, "HIGH");
});

test("volume/liquidity = 30×: anomaly, volume points discounted, risk up", () => {
  const s = score({ volumeH1: 2_400_000, volumeH6: 3_000_000, volumeH24: 4_000_000 });
  assertWellFormed(s);
  assert.equal(deduction(s, "turnover"), 25);
  assert.ok(titles(s).includes(ANOMALY.turnover));
  assert.equal(item(s, "volume", "turnover").points, 0);
  assert.ok(item(s, "volume", "h1").points < SCORING_CONFIG.opportunity.volume.h1Max);
  assert.equal(riskOf(s, "turnover"), 18);
});

test("volume/liquidity = 200×: maximal deduction, huge volume is not rewarded", () => {
  const s = score({ volumeH1: 16_000_000, volumeH6: 20_000_000, volumeH24: 30_000_000 });
  assertWellFormed(s);
  assert.equal(deduction(s, "turnover"), 40);
  assert.equal(riskOf(s, "turnover"), 30);
  assert.ok(s.quality <= 60);
  const h1 = item(s, "volume", "h1");
  assert.ok(h1.points <= SCORING_CONFIG.opportunity.volume.h1Max * 0.2 + 1e-9, `vol h1 ${h1.points}`);
  assert.ok(s.categories.volume.points < score().categories.volume.points);
});

test("+1000 % in 1 h: Quality strongly reduced even when Momentum points exist", () => {
  const s = score({ priceChangeH1: 1_000, priceChangeH6: 1_000, priceChangeM5: 20, pairCreatedAt: minutesAgo(55) });
  assertWellFormed(s);
  assert.equal(deduction(s, "pump"), 30);
  assert.ok(titles(s).includes(ANOMALY.extremeMove));
  assert.ok(s.categories.momentum.points > 0);
  assert.ok(s.quality <= 70, `quality ${s.quality}`);
  assert.notEqual(s.confidence.level, "HIGH");
});

test("−95 % in 1 h: Quality strongly reduced", () => {
  const s = score({ priceChangeH1: -95, priceChangeH6: -94, priceChangeM5: -10 });
  assertWellFormed(s);
  assert.equal(deduction(s, "dump"), 30);
  assert.ok(titles(s).includes(ANOMALY.extremeMove));
  assert.ok(s.quality <= 70);
  assert.equal(s.label, "HIGH RISK");
});

test("3-minute-old token: Opportunity can be high but Confidence is LOW", () => {
  const s = score({
    pairCreatedAt: minutesAgo(3),
    volumeM5: 30_000,
    volumeH1: 60_000,
    volumeH6: 60_000,
    volumeH24: 60_000,
    buysM5: 300,
    sellsM5: 200,
    buysH1: 520,
    sellsH1: 380,
    priceChangeM5: 15,
    priceChangeH1: 30,
    priceChangeH6: 30,
  });
  assertWellFormed(s);
  assert.equal(s.confidence.level, "LOW");
  assert.ok(s.confidence.caps.some((c) => /moins de 15 min/.test(c)));
  assert.ok(deduction(s, "veryNew") > 0);
  assert.ok(s.opportunity >= 55, `opportunity ${s.opportunity}`);
  assert.notEqual(s.label, "MOMENTUM");
});

test("several missing fields: Quality and Confidence drop, nothing is read as 0", () => {
  const s = score({ liquidityUsd: null, priceChangeM5: null, volumeM5: null, buysM5: null, sellsM5: null, pairCreatedAt: null });
  assertWellFormed(s);
  assert.equal(deduction(s, "missingLiquidity"), SCORING_CONFIG.quality.missingLiquidity);
  assert.equal(deduction(s, "missing"), SCORING_CONFIG.quality.missingField.max);
  assert.equal(s.confidence.level, "LOW");
  const completeness = s.confidence.parts.find((p) => p.label === "Données disponibles")!;
  assert.equal(completeness.detail, "7 / 13 champs");
  // Missing values don't trigger value-based anomalies (e.g. no turnover or small-ticket guess).
  assert.equal(s.observed.turnoverH1, null);
  assert.equal(s.observed.avgTicketM5, null);
  assert.equal(deduction(s, "turnover"), 0);
  assert.ok(s.signals.negative.some((n) => n.startsWith("Données absentes")));
});

test("inconsistent time windows are an anomaly and remove the consistency confidence", () => {
  const s = score({ volumeM5: 250_000 });
  assert.ok(titles(s).includes(ANOMALY.windows));
  assert.equal(s.confidence.parts.find((p) => p.label === "Cohérence des fenêtres")!.points, 0);
});

test("scoring never modifies the raw pair", () => {
  const raw = pair({ buysM5: 573, sellsM5: 4, volumeH1: 2_000_000 });
  const copy = structuredClone(raw);
  scorePair(raw, NOW);
  assert.deepEqual(raw, copy);
});

test("divergence needs a nearly flat price, not a large move in either direction", () => {
  const flow = { buysH1: 1_500, sellsH1: 600 };
  assert.equal(score({ ...flow, priceChangeH1: -30 }).qualityDetail.divergenceH1.triggered, false);
  assert.equal(score({ ...flow, priceChangeH1: -1 }).qualityDetail.divergenceH1.triggered, true);
});

test("pump.fun pair without liquidity.usd can't reach HIGH confidence", () => {
  const s = score({ dexId: "pumpfun", liquidityUsd: null });
  assert.equal(s.confidence.level, "MEDIUM");
  assert.ok(s.confidence.caps.includes("liquidité absente"));
});
