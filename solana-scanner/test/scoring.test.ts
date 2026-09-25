import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { SCORING_CONFIG } from "../src/scoring/config.ts";
import type { ScoringConfig } from "../src/scoring/config.ts";
import { CATEGORY_ORDER, interpolate, scorePair, scorePairs } from "../src/scoring/score.ts";
import type { PairScore } from "../src/scoring/score.ts";
import { NO_FILTERS, applyFilters } from "../src/scoring/filters.ts";

const NOW = Date.UTC(2026, 8, 25, 18, 0, 0);
const minutesAgo = (m: number) => NOW - m * 60_000;

/** A healthy, actively traded pair with steady positive momentum. */
function pair(overrides: Partial<NormalizedPair> = {}): NormalizedPair {
  return {
    chainId: "solana",
    dexId: "raydium",
    url: "https://dexscreener.com/solana/PAIR",
    pairAddress: "PAIR",
    tokenAddress: "TOKEN",
    tokenName: "Healthy",
    tokenSymbol: "HLT",
    quoteSymbol: "SOL",
    priceUsd: 0.0004,
    marketCap: 400_000,
    fdv: 400_000,
    liquidityUsd: 80_000,
    volumeM5: 9_000,
    volumeH1: 90_000,
    volumeH6: 300_000,
    volumeH24: 800_000,
    buysM5: 60,
    sellsM5: 30,
    buysH1: 520,
    sellsH1: 330,
    priceChangeM5: 4,
    priceChangeH1: 25,
    priceChangeH6: 40,
    pairCreatedAt: minutesAgo(180),
    ...overrides,
  };
}

const NULL_METRICS: Partial<NormalizedPair> = {
  priceUsd: null,
  marketCap: null,
  fdv: null,
  liquidityUsd: null,
  volumeM5: null,
  volumeH1: null,
  volumeH6: null,
  volumeH24: null,
  buysM5: null,
  sellsM5: null,
  buysH1: null,
  sellsH1: null,
  priceChangeM5: null,
  priceChangeH1: null,
  priceChangeH6: null,
  pairCreatedAt: null,
};

const score = (overrides: Partial<NormalizedPair> = {}, config?: ScoringConfig) => scorePair(pair(overrides), NOW, config);
const factor = (s: PairScore, key: string) => s.riskFactors.find((f) => f.key === key)?.points ?? 0;
const item = (s: PairScore, cat: keyof PairScore["categories"], key: string) => {
  const it = s.categories[cat].items.find((i) => i.key === key);
  assert.ok(it, `item ${cat}.${key} exists`);
  return it;
};

/** Invariants that must hold for every score. */
function assertWellFormed(s: PairScore) {
  assert.ok(Number.isInteger(s.opportunity) && s.opportunity >= 0 && s.opportunity <= 100, `opportunity ${s.opportunity}`);
  assert.ok(Number.isInteger(s.risk) && s.risk >= 0 && s.risk <= 100, `risk ${s.risk}`);
  let sum = 0;
  for (const k of CATEGORY_ORDER) {
    const c = s.categories[k];
    assert.ok(Number.isFinite(c.points), `${k} finite`);
    assert.ok(c.points >= 0 && c.points <= c.max, `${k} ${c.points}/${c.max}`);
    for (const it of c.items) {
      assert.ok(Number.isFinite(it.points) && it.points >= 0 && it.points <= it.max + 1e-9, `${k}.${it.key} ${it.points}/${it.max}`);
    }
    sum += c.points;
  }
  assert.equal(Math.round(sum), s.opportunity, "opportunity is exactly the sum of the categories");
  for (const f of s.riskFactors) assert.ok(Number.isFinite(f.points) && f.points > 0);
}

// ─── configuration ──────────────────────────────────────────────────────────

test("category maxima add up to 100 and item maxima add up to each category", () => {
  const o = SCORING_CONFIG.opportunity;
  assert.equal(o.momentum.max + o.volume.max + o.buyPressure.max + o.liquidity.max + o.marketCap.max + o.age.max, 100);
  assert.deepEqual([o.momentum.max, o.volume.max, o.buyPressure.max, o.liquidity.max, o.marketCap.max, o.age.max], [25, 20, 20, 15, 10, 10]);
  assert.equal(o.momentum.m5Max + o.momentum.h1Max + o.momentum.accelMax + o.momentum.h6Max, o.momentum.max);
  assert.equal(o.volume.m5Max + o.volume.h1Max + o.volume.turnoverMax + o.volume.accelMax, o.volume.max);
  assert.equal(o.buyPressure.ratioM5Max + o.buyPressure.ratioH1Max + o.buyPressure.activityMax, o.buyPressure.max);
  assert.equal(o.liquidity.usdMax + o.liquidity.ratioMax, o.liquidity.max);
});

test("interpolate is linear between points and clamped outside", () => {
  const c = [
    [0, 0],
    [10, 1],
    [20, 0.5],
  ] as const;
  assert.equal(interpolate(c, -5), 0);
  assert.equal(interpolate(c, 5), 0.5);
  assert.equal(interpolate(c, 15), 0.75);
  assert.equal(interpolate(c, 99), 0.5);
});

test("thresholds come from the config: changing a curve changes the score", () => {
  const custom: ScoringConfig = structuredClone(SCORING_CONFIG);
  custom.opportunity.marketCap.curve = [[0, 0]];
  const s = score({}, custom);
  assert.equal(s.categories.marketCap.points, 0);
  assert.ok(score().categories.marketCap.points > 0);
});

// ─── required scenarios ─────────────────────────────────────────────────────

test("healthy token with momentum: high opportunity, low risk, MOMENTUM label", () => {
  const s = score();
  assertWellFormed(s);
  assert.ok(s.opportunity >= 75, `opportunity ${s.opportunity}`);
  assert.ok(s.risk <= 10, `risk ${s.risk}`);
  assert.equal(s.label, "MOMENTUM");
  assert.ok(s.categories.momentum.points >= 20);
  assert.equal(s.categories.momentum.cap, undefined);
  assert.deepEqual(s.missingFields, []);
  for (const k of CATEGORY_ORDER) for (const it of s.categories[k].items) assert.equal(it.missing, false);
});

test("pump.fun token without liquidity.usd: liquidity is absent, not zero", () => {
  const s = score({ dexId: "pumpfun", liquidityUsd: null, marketCap: 15_000 });
  assertWellFormed(s);
  const usd = item(s, "liquidity", "usd");
  assert.equal(usd.missing, true);
  assert.equal(usd.input, "absent");
  assert.equal(usd.points, 0);
  assert.match(usd.note ?? "", /bonding curve/);
  assert.equal(item(s, "liquidity", "ratio").missing, true);
  assert.equal(item(s, "volume", "turnover").missing, true);
  assert.equal(s.categories.liquidity.points, 0);
  assert.ok(s.categories.marketCap.points <= SCORING_CONFIG.opportunity.marketCap.illiquid.cap);
  assert.equal(factor(s, "bondingCurve"), SCORING_CONFIG.risk.bondingCurveNoLiquidity);
  // The "low liquidity" curve (which would fire at $0) is not applied to an absent value.
  assert.equal(factor(s, "lowLiquidity"), 0);
  assert.ok(s.missingFields.includes("liquidity.usd"));
  assert.ok(s.risk > score().risk);
});

test("missing liquidity on a non pump.fun DEX uses the generic missing-liquidity factor", () => {
  const s = score({ liquidityUsd: null });
  assert.equal(factor(s, "missingLiquidity"), SCORING_CONFIG.risk.missingLiquidity);
  assert.equal(factor(s, "bondingCurve"), 0);
});

test("token with only 2 transactions: buy pressure isn't inflated", () => {
  const s = score({ buysM5: 2, sellsM5: 0, buysH1: 2, sellsH1: 0, volumeM5: 150, volumeH1: 150 });
  assertWellFormed(s);
  const m5 = item(s, "buyPressure", "m5");
  const h1 = item(s, "buyPressure", "h1");
  assert.equal(m5.points, 0);
  assert.equal(h1.points, 0);
  assert.match(m5.note ?? "", /Seulement 2 transactions/);
  assert.equal(item(s, "buyPressure", "activity").points, 0);
  assert.equal(s.categories.age.points, 0, "no real activity → no age points");
  assert.equal(factor(s, "fewTxns"), 15);
  assert.ok(s.opportunity < 50);
});

test("token that just did +1000 %: momentum capped, violent move adds risk", () => {
  const s = score({ priceChangeM5: 40, priceChangeH1: 1000, priceChangeH6: 1000, pairCreatedAt: minutesAgo(50) });
  assertWellFormed(s);
  const cap = SCORING_CONFIG.opportunity.momentum.extreme.cap;
  assert.ok(s.categories.momentum.points <= cap);
  assert.ok(s.categories.momentum.cap, "cap is reported");
  assert.match(s.categories.momentum.cap.reason, /extrême/);
  assert.ok(s.categories.momentum.points < score().categories.momentum.points);
  assert.equal(factor(s, "violentH1"), 15);
  assert.ok(factor(s, "violentM5") > 0);
  assert.notEqual(s.label, "MOMENTUM");
});

test("token down −95 %: near-zero momentum, heavy crash risk", () => {
  const s = score({ priceChangeM5: -20, priceChangeH1: -95, priceChangeH6: -95 });
  assertWellFormed(s);
  assert.ok(s.categories.momentum.points <= 3, `momentum ${s.categories.momentum.points}`);
  assert.equal(factor(s, "crash"), 40);
  assert.equal(s.label, "HIGH RISK");
  assert.ok(factor(s, "crashM5") > 0);
  assert.notEqual(s.label, "MOMENTUM");
  assert.notEqual(s.label, "WATCH");
});

test("all metrics missing: no NaN, zero opportunity, every item flagged, risk raised", () => {
  const s = score({ ...NULL_METRICS, dexId: null });
  assertWellFormed(s);
  assert.equal(s.opportunity, 0);
  for (const k of CATEGORY_ORDER) for (const it of s.categories[k].items) assert.equal(it.missing, true, `${k}.${it.key}`);
  assert.equal(factor(s, "missingData"), SCORING_CONFIG.risk.missingField.max);
  assert.equal(factor(s, "missingLiquidity"), SCORING_CONFIG.risk.missingLiquidity);
  assert.equal(s.ageMinutes, null);
  assert.ok(s.missingFields.includes("priceChange.m5"));
  assert.ok(s.missingFields.includes("pairCreatedAt"));
  assert.equal(s.label, null);
});

test("one missing field only affects the items that need it", () => {
  const s = score({ priceChangeM5: null });
  assertWellFormed(s);
  assert.equal(item(s, "momentum", "m5").missing, true);
  assert.equal(item(s, "momentum", "accel").missing, true);
  assert.equal(item(s, "momentum", "h1").missing, false);
  assert.ok(item(s, "momentum", "h1").points > 0);
  assert.equal(factor(s, "missingData"), SCORING_CONFIG.risk.missingField.perField);
  assert.ok(s.opportunity < score().opportunity);
});

test("missing value is not the same as a real 0", () => {
  const absent = score({ priceChangeM5: null });
  const zero = score({ priceChangeM5: 0 });
  assert.equal(item(absent, "momentum", "m5").points, 0);
  assert.ok(item(zero, "momentum", "m5").points > 0, "a flat 0 % move is real data and earns partial points");
});

test("huge volume on tiny liquidity: turnover gets no opportunity points and high risk", () => {
  const s = score({ liquidityUsd: 3_000, marketCap: 6_000, volumeH1: 2_000_000, volumeM5: 200_000 });
  assertWellFormed(s);
  assert.equal(item(s, "volume", "turnover").points, 0);
  assert.equal(factor(s, "turnover"), 18);
  assert.ok(factor(s, "lowLiquidity") >= 18);
  assert.ok(s.categories.marketCap.points <= SCORING_CONFIG.opportunity.marketCap.illiquid.cap);
  assert.ok(s.risk >= SCORING_CONFIG.labels.highRisk.minRisk);
  assert.equal(s.label, "HIGH RISK");
});

// ─── other rules ────────────────────────────────────────────────────────────

test("a brand-new pair without trades earns no age points; with real trades it does", () => {
  const idle = score({ pairCreatedAt: minutesAgo(3), buysH1: 3, sellsH1: 1 });
  const active = score({ pairCreatedAt: minutesAgo(40), buysH1: 400, sellsH1: 250 });
  assert.equal(idle.categories.age.points, 0);
  assert.ok(factor(idle, "veryNew") > 0);
  assert.ok(active.categories.age.points >= 8);
});

test("young pairs compare 5-min change to their real h1 window", () => {
  // 10 min old, +20 % since creation → average +10 % per 5 min, so +10 % now is no acceleration.
  const s = score({ pairCreatedAt: minutesAgo(10), priceChangeH1: 20, priceChangeM5: 10 });
  assert.match(item(s, "momentum", "accel").input, /^0\.00 pts/);
});

test("labels are only descriptive tags", () => {
  const labels = new Set(
    [score(), score({ liquidityUsd: 1_000 }), score({ priceChangeH1: -95 }), score({ ...NULL_METRICS })].map((s) => s.label),
  );
  for (const l of labels) assert.ok(l === null || ["WATCH", "MOMENTUM", "HIGH RISK"].includes(l));
});

test("filters exclude pairs whose tested value is missing", () => {
  const rows = scorePairs(
    [pair({ pairAddress: "A" }), pair({ pairAddress: "B", liquidityUsd: null, dexId: "pumpfun" }), pair({ pairAddress: "C", liquidityUsd: 9_000 })],
    NOW,
  );
  const ids = (f: Partial<typeof NO_FILTERS>) => applyFilters(rows, { ...NO_FILTERS, ...f }).map((r) => r.pair.pairAddress);
  assert.deepEqual(ids({}), ["A", "B", "C"]);
  assert.deepEqual(ids({ minLiquidity: 5_000 }), ["A", "C"]);
  assert.deepEqual(ids({ minLiquidity: 10_000 }), ["A"]);
  assert.deepEqual(ids({ maxAgeMinutes: 60 }), []);
  assert.deepEqual(ids({ maxAgeMinutes: 200, minMarketCap: 100_000, maxMarketCap: 500_000 }), ["A", "B", "C"]);
  assert.deepEqual(ids({ maxRisk: 10 }), ["A"]);
  assert.deepEqual(ids({ minOpportunity: 101 }), []);
  assert.deepEqual(ids({ minVolumeH1: 100_000 }), []);
});
