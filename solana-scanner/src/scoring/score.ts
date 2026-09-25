/**
 * Scoring engine: turns one NormalizedPair into two independent scores.
 *
 *   - Opportunity (0–100): quality of the setup and observed momentum,
 *     split into six categories (see config.ts for every rule).
 *   - Risk (0–100): sum of risk factors, capped.
 *
 * Both are descriptions of current DEX Screener data, not predictions.
 * Pure function of (pair, now, config): no I/O, deterministic, testable.
 *
 * A missing input is never read as 0: the item it feeds earns no points,
 * is flagged `missing`, and the gap raises the Risk score.
 */

import type { NormalizedPair } from "../domain/normalize.ts";
import { SCORING_CONFIG } from "./config.ts";
import type { Curve, ScoringConfig } from "./config.ts";

export type CategoryKey = "momentum" | "volume" | "buyPressure" | "liquidity" | "marketCap" | "age";

export const CATEGORY_ORDER: readonly CategoryKey[] = [
  "momentum",
  "volume",
  "buyPressure",
  "liquidity",
  "marketCap",
  "age",
];

export const CATEGORY_LABEL: Record<CategoryKey, string> = {
  momentum: "Momentum",
  volume: "Volume",
  buyPressure: "Buy Pressure",
  liquidity: "Liquidity",
  marketCap: "Market Cap",
  age: "Age",
};

export type Label = "WATCH" | "MOMENTUM" | "HIGH RISK";

export interface ScoreItem {
  key: string;
  label: string;
  /** The measured input, human-readable (e.g. "+12.40 %"), or "absent". */
  input: string;
  points: number;
  max: number;
  /** True when a required DEX Screener field was absent. */
  missing: boolean;
  note?: string;
}

export interface CategoryScore {
  key: CategoryKey;
  label: string;
  max: number;
  /** Final points, after any cap. */
  points: number;
  /** Sum of item points before any cap. */
  uncapped: number;
  /** Set when a capping rule was triggered (it may not bind if `uncapped` is already lower). */
  cap?: { points: number; reason: string };
  items: ScoreItem[];
}

export interface RiskFactor {
  key: string;
  label: string;
  input: string;
  points: number;
}

export interface PairScore {
  /** Opportunity score, integer 0–100. */
  opportunity: number;
  /** Unrounded sum of category points. */
  opportunityExact: number;
  categories: Record<CategoryKey, CategoryScore>;
  /** Risk score, integer 0–100. */
  risk: number;
  /** Sum of risk factors before the cap. */
  riskUncapped: number;
  /** Only factors that added points, highest first. */
  riskFactors: RiskFactor[];
  /** Important DEX Screener fields that were absent. */
  missingFields: string[];
  label: Label | null;
  labelReason: string;
  /** Pair age in minutes at scoring time, null if pairCreatedAt is absent. */
  ageMinutes: number | null;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Piecewise-linear interpolation, clamped at both ends. */
export function interpolate(curve: Curve, x: number): number {
  if (curve.length === 0) return 0;
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return curve[curve.length - 1][1];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const ABSENT = "absent";
const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)} %`;
const fmtPts = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)} pts`;
const fmtUsd = (n: number) =>
  `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)}`;
const fmtRatio = (n: number) => `${n.toFixed(2)}×`;
const fmtInt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
const fmtAge = (min: number) =>
  min < 60 ? `${min.toFixed(0)} min` : min < 2_880 ? `${(min / 60).toFixed(1)} h` : `${(min / 1_440).toFixed(1)} j`;

function curveItem(
  key: string,
  label: string,
  value: number | null,
  curve: Curve,
  max: number,
  format: (n: number) => string,
  missingFields: string[] = [],
): ScoreItem {
  if (value === null) {
    return { key, label, input: ABSENT, points: 0, max, missing: true, note: absentNote(missingFields) };
  }
  return { key, label, input: format(value), points: max * interpolate(curve, value), max, missing: false };
}

function absentNote(fields: string[]): string {
  const list = fields.length ? ` (${fields.join(", ")})` : "";
  return `Donnée absente${list} : aucun point attribué, valeur non supposée.`;
}

function category(key: CategoryKey, max: number, items: ScoreItem[], cap?: { points: number; reason: string }): CategoryScore {
  for (const it of items) it.points = round1(it.points);
  const uncapped = round1(items.reduce((s, it) => s + it.points, 0));
  return {
    key,
    label: CATEGORY_LABEL[key],
    max,
    points: Math.min(max, uncapped, cap ? cap.points : max),
    uncapped,
    cap,
    items,
  };
}

/** Minutes covered by the "h1" window: the pair's age if younger than an hour. */
function h1WindowMinutes(ageMinutes: number | null): number {
  if (ageMinutes === null) return 60;
  return Math.min(60, Math.max(5, ageMinutes));
}

function sum(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

// ─── Opportunity categories ─────────────────────────────────────────────────

function scoreMomentum(p: NormalizedPair, ageMin: number | null, c: ScoringConfig["opportunity"]["momentum"]): CategoryScore {
  const items: ScoreItem[] = [
    curveItem("m5", "Variation prix 5 min", p.priceChangeM5, c.m5, c.m5Max, fmtPct, ["priceChange.m5"]),
    curveItem("h1", "Variation prix 1 h", p.priceChangeH1, c.h1, c.h1Max, fmtPct, ["priceChange.h1"]),
  ];

  // Acceleration: is the last 5 min faster than the hour's average 5-min pace?
  if (p.priceChangeM5 === null || p.priceChangeH1 === null) {
    const missing = [p.priceChangeM5 === null && "priceChange.m5", p.priceChangeH1 === null && "priceChange.h1"].filter(
      Boolean,
    ) as string[];
    items.push({ key: "accel", label: "Accélération récente", input: ABSENT, points: 0, max: c.accelMax, missing: true, note: absentNote(missing) });
  } else {
    const avg5m = p.priceChangeH1 / (h1WindowMinutes(ageMin) / 5);
    const accel = p.priceChangeM5 - avg5m;
    items.push({
      key: "accel",
      label: "Accélération récente",
      input: `${fmtPts(accel)} (5 min ${fmtPct(p.priceChangeM5)} vs moyenne ${fmtPct(avg5m)} / 5 min)`,
      points: c.accelMax * interpolate(c.accel, accel),
      max: c.accelMax,
      missing: false,
    });
  }

  items.push(curveItem("h6", "Tendance 6 h", p.priceChangeH6, c.h6, c.h6Max, fmtPct, ["priceChange.h6"]));

  const extremes: string[] = [];
  if (p.priceChangeM5 !== null && p.priceChangeM5 >= c.extreme.m5) extremes.push(`5 min ${fmtPct(p.priceChangeM5)} ≥ ${c.extreme.m5} %`);
  if (p.priceChangeH1 !== null && p.priceChangeH1 >= c.extreme.h1) extremes.push(`1 h ${fmtPct(p.priceChangeH1)} ≥ ${c.extreme.h1} %`);
  if (p.priceChangeH6 !== null && p.priceChangeH6 >= c.extreme.h6) extremes.push(`6 h ${fmtPct(p.priceChangeH6)} ≥ ${c.extreme.h6} %`);
  const cap = extremes.length
    ? { points: c.extreme.cap, reason: `Hausse déjà extrême (${extremes.join(", ")}) : Momentum plafonné à ${c.extreme.cap}/${c.max}.` }
    : undefined;

  return category("momentum", c.max, items, cap);
}

function scoreVolume(p: NormalizedPair, ageMin: number | null, c: ScoringConfig["opportunity"]["volume"]): CategoryScore {
  const items: ScoreItem[] = [
    curveItem("m5", "Volume 5 min", p.volumeM5, c.m5, c.m5Max, fmtUsd, ["volume.m5"]),
    curveItem("h1", "Volume 1 h", p.volumeH1, c.h1, c.h1Max, fmtUsd, ["volume.h1"]),
  ];

  // Turnover
  if (p.volumeH1 === null || p.liquidityUsd === null) {
    const missing = [p.volumeH1 === null && "volume.h1", p.liquidityUsd === null && "liquidity.usd"].filter(Boolean) as string[];
    items.push({ key: "turnover", label: "Volume 1 h / liquidité", input: ABSENT, points: 0, max: c.turnoverMax, missing: true, note: absentNote(missing) });
  } else if (p.liquidityUsd <= 0) {
    items.push({ key: "turnover", label: "Volume 1 h / liquidité", input: "liquidité = $0", points: 0, max: c.turnoverMax, missing: false, note: "Ratio non calculable." });
  } else {
    const t = p.volumeH1 / p.liquidityUsd;
    items.push({
      key: "turnover",
      label: "Volume 1 h / liquidité",
      input: fmtRatio(t),
      points: c.turnoverMax * interpolate(c.turnover, t),
      max: c.turnoverMax,
      missing: false,
      note: t > 6 ? "Rotation très élevée par rapport à la liquidité : points réduits." : undefined,
    });
  }

  // Volume acceleration
  if (p.volumeM5 === null || p.volumeH1 === null) {
    const missing = [p.volumeM5 === null && "volume.m5", p.volumeH1 === null && "volume.h1"].filter(Boolean) as string[];
    items.push({ key: "accel", label: "Accélération du volume", input: ABSENT, points: 0, max: c.accelMax, missing: true, note: absentNote(missing) });
  } else if (p.volumeH1 <= 0) {
    items.push({ key: "accel", label: "Accélération du volume", input: "volume 1 h = $0", points: 0, max: c.accelMax, missing: false, note: "Aucun volume sur 1 h : accélération non calculable." });
  } else {
    const avg5m = p.volumeH1 / (h1WindowMinutes(ageMin) / 5);
    const r = p.volumeM5 / avg5m;
    items.push({
      key: "accel",
      label: "Accélération du volume",
      input: `${fmtRatio(r)} (5 min ${fmtUsd(p.volumeM5)} vs moyenne ${fmtUsd(avg5m)} / 5 min)`,
      points: c.accelMax * interpolate(c.accel, r),
      max: c.accelMax,
      missing: false,
    });
  }

  return category("volume", c.max, items);
}

function ratioItem(
  key: string,
  label: string,
  buys: number | null,
  sells: number | null,
  curve: Curve,
  max: number,
  conf: { min: number; full: number },
  fields: [string, string],
): ScoreItem {
  if (buys === null || sells === null) {
    const missing = [buys === null && fields[0], sells === null && fields[1]].filter(Boolean) as string[];
    return { key, label, input: ABSENT, points: 0, max, missing: true, note: absentNote(missing) };
  }
  const n = buys + sells;
  if (n === 0) return { key, label, input: "0 transaction", points: 0, max, missing: false, note: "Aucune transaction : ratio non calculable." };
  const ratio = buys / n;
  const confidence = n < conf.min ? 0 : Math.min(1, n / conf.full);
  const raw = max * interpolate(curve, ratio);
  const note =
    confidence < 1
      ? n < conf.min
        ? `Seulement ${n} transactions (< ${conf.min}) : ratio ignoré.`
        : `${n} transactions (< ${conf.full}) : confiance ${(confidence * 100).toFixed(0)} %, points ${raw.toFixed(1)} → ${(raw * confidence).toFixed(1)}.`
      : undefined;
  return {
    key,
    label,
    input: `${fmtInt(buys)} achats / ${fmtInt(sells)} ventes (${(ratio * 100).toFixed(0)} % achats)`,
    points: raw * confidence,
    max,
    missing: false,
    note,
  };
}

function scoreBuyPressure(p: NormalizedPair, c: ScoringConfig["opportunity"]["buyPressure"]): CategoryScore {
  const txH1 = sum(p.buysH1, p.sellsH1);
  const items = [
    ratioItem("m5", "Achats vs ventes 5 min", p.buysM5, p.sellsM5, c.ratioM5, c.ratioM5Max, c.confidenceM5, ["txns.m5.buys", "txns.m5.sells"]),
    ratioItem("h1", "Achats vs ventes 1 h", p.buysH1, p.sellsH1, c.ratioH1, c.ratioH1Max, c.confidenceH1, ["txns.h1.buys", "txns.h1.sells"]),
    curveItem("activity", "Nombre de transactions 1 h", txH1, c.activity, c.activityMax, fmtInt, ["txns.h1.buys", "txns.h1.sells"]),
  ];
  return category("buyPressure", c.max, items);
}

function scoreLiquidity(p: NormalizedPair, c: ScoringConfig["opportunity"]["liquidity"], bondingCurve: boolean): CategoryScore {
  const usd = curveItem("usd", "Liquidité (USD)", p.liquidityUsd, c.usd, c.usdMax, fmtUsd, ["liquidity.usd"]);
  if (usd.missing && bondingCurve) usd.note = "Paire pump.fun en bonding curve : DEX Screener ne fournit pas liquidity.usd. Aucun point attribué.";
  const items: ScoreItem[] = [usd];
  if (p.liquidityUsd === null || p.marketCap === null) {
    const missing = [p.liquidityUsd === null && "liquidity.usd", p.marketCap === null && "marketCap"].filter(Boolean) as string[];
    items.push({ key: "ratio", label: "Liquidité / market cap", input: ABSENT, points: 0, max: c.ratioMax, missing: true, note: absentNote(missing) });
  } else if (p.marketCap <= 0) {
    items.push({ key: "ratio", label: "Liquidité / market cap", input: "market cap = $0", points: 0, max: c.ratioMax, missing: false, note: "Ratio non calculable." });
  } else {
    const r = p.liquidityUsd / p.marketCap;
    items.push({
      key: "ratio",
      label: "Liquidité / market cap",
      input: `${(r * 100).toFixed(1)} %`,
      points: c.ratioMax * interpolate(c.ratio, r),
      max: c.ratioMax,
      missing: false,
      note: r > 1 ? "Liquidité supérieure à la market cap : situation inhabituelle, points réduits." : undefined,
    });
  }
  return category("liquidity", c.max, items);
}

function scoreMarketCap(p: NormalizedPair, c: ScoringConfig["opportunity"]["marketCap"]): CategoryScore {
  const item = curveItem("mcap", "Profil de market cap", p.marketCap, c.curve, c.max, fmtUsd, ["marketCap"]);
  let cap: { points: number; reason: string } | undefined;
  if (p.liquidityUsd === null) {
    cap = { points: c.illiquid.cap, reason: `Liquidité absente : Market Cap plafonné à ${c.illiquid.cap}/${c.max}.` };
  } else if (p.liquidityUsd < c.illiquid.minLiquidityUsd) {
    cap = {
      points: c.illiquid.cap,
      reason: `Liquidité ${fmtUsd(p.liquidityUsd)} < ${fmtUsd(c.illiquid.minLiquidityUsd)} : Market Cap plafonné à ${c.illiquid.cap}/${c.max}.`,
    };
  }
  return category("marketCap", c.max, [item], cap);
}

function scoreAge(p: NormalizedPair, ageMin: number | null, c: ScoringConfig["opportunity"]["age"]): CategoryScore {
  const txH1 = sum(p.buysH1, p.sellsH1);
  if (ageMin === null || txH1 === null) {
    const missing = [ageMin === null && "pairCreatedAt", txH1 === null && "txns.h1"].filter(Boolean) as string[];
    return category("age", c.max, [
      { key: "age", label: "Âge × activité réelle", input: ABSENT, points: 0, max: c.max, missing: true, note: absentNote(missing) },
    ]);
  }
  const ageF = interpolate(c.ageCurve, ageMin);
  const actF = interpolate(c.activityCurve, txH1);
  return category("age", c.max, [
    {
      key: "age",
      label: "Âge × activité réelle",
      input: `${fmtAge(ageMin)}, ${fmtInt(txH1)} transactions / 1 h`,
      points: c.max * ageF * actF,
      max: c.max,
      missing: false,
      note: `Facteur âge ${(ageF * 100).toFixed(0)} % × facteur activité ${(actF * 100).toFixed(0)} %.${
        actF === 0 ? " Sans activité réelle, un token récent ne reçoit aucun point." : ""
      }`,
    },
  ]);
}

// ─── Risk ───────────────────────────────────────────────────────────────────

const IMPORTANT_FIELDS: [keyof NormalizedPair, string][] = [
  ["priceUsd", "priceUsd"],
  ["marketCap", "marketCap"],
  ["volumeM5", "volume.m5"],
  ["volumeH1", "volume.h1"],
  ["buysM5", "txns.m5.buys"],
  ["sellsM5", "txns.m5.sells"],
  ["buysH1", "txns.h1.buys"],
  ["sellsH1", "txns.h1.sells"],
  ["priceChangeM5", "priceChange.m5"],
  ["priceChangeH1", "priceChange.h1"],
  ["priceChangeH6", "priceChange.h6"],
  ["pairCreatedAt", "pairCreatedAt"],
];

function scoreRisk(p: NormalizedPair, ageMin: number | null, c: ScoringConfig["risk"], bondingCurve: boolean) {
  const factors: RiskFactor[] = [];
  const add = (key: string, label: string, input: string, points: number) => {
    if (points > 0) factors.push({ key, label, input, points: round1(points) });
  };

  if (p.liquidityUsd === null) {
    if (bondingCurve) add("bondingCurve", "pump.fun bonding curve sans liquidity.usd", `dex ${p.dexId}`, c.bondingCurveNoLiquidity);
    else add("missingLiquidity", "Liquidité absente", "liquidity.usd absent", c.missingLiquidity);
  } else {
    add("lowLiquidity", "Liquidité faible", fmtUsd(p.liquidityUsd), interpolate(c.lowLiquidity, p.liquidityUsd));
  }

  if (p.marketCap !== null) add("lowMarketCap", "Market cap extrêmement faible", fmtUsd(p.marketCap), interpolate(c.lowMarketCap, p.marketCap));

  const txH1 = sum(p.buysH1, p.sellsH1);
  if (txH1 !== null) add("fewTxns", "Très peu de transactions", `${fmtInt(txH1)} transactions / 1 h`, interpolate(c.fewTransactions, txH1));

  const drops = [p.priceChangeH1, p.priceChangeH6].filter((v): v is number => v !== null);
  if (drops.length) {
    const worst = Math.min(...drops);
    add("crash", "Chute de prix extrême", `pire variation 1 h / 6 h : ${fmtPct(worst)}`, interpolate(c.priceCrash, worst));
  }
  if (p.priceChangeM5 !== null) add("crashM5", "Chute brutale sur 5 min", fmtPct(p.priceChangeM5), interpolate(c.priceCrashM5, p.priceChangeM5));

  if (p.volumeH1 !== null && p.liquidityUsd !== null && p.liquidityUsd > 0) {
    const t = p.volumeH1 / p.liquidityUsd;
    add("turnover", "Volume anormal par rapport à la liquidité", `volume 1 h = ${fmtRatio(t)} la liquidité`, interpolate(c.abnormalTurnover, t));
  }

  if (p.priceChangeM5 !== null)
    add("violentM5", "Mouvement violent sur 5 min", fmtPct(p.priceChangeM5), interpolate(c.violentM5, Math.abs(p.priceChangeM5)));
  if (p.priceChangeH1 !== null)
    add("violentH1", "Mouvement violent sur 1 h", fmtPct(p.priceChangeH1), interpolate(c.violentH1, Math.abs(p.priceChangeH1)));

  if (ageMin !== null) add("veryNew", "Paire très récente", fmtAge(ageMin), interpolate(c.veryNew, ageMin));

  const missingFields = IMPORTANT_FIELDS.filter(([f]) => p[f] === null).map(([, path]) => path);
  if (missingFields.length) {
    add(
      "missingData",
      "Données importantes manquantes",
      missingFields.join(", "),
      Math.min(c.missingField.max, missingFields.length * c.missingField.perField),
    );
  }
  if (p.liquidityUsd === null) missingFields.unshift("liquidity.usd");

  factors.sort((a, b) => b.points - a.points);
  const uncapped = round1(factors.reduce((s, f) => s + f.points, 0));
  return { risk: Math.round(Math.min(c.cap, uncapped)), riskUncapped: uncapped, riskFactors: factors, missingFields };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

function pickLabel(opp: number, risk: number, momentum: number, c: ScoringConfig["labels"]): { label: Label | null; reason: string } {
  if (risk >= c.highRisk.minRisk) return { label: "HIGH RISK", reason: `Risk ${risk} ≥ ${c.highRisk.minRisk}.` };
  if (opp >= c.momentum.minOpportunity && momentum >= c.momentum.minMomentum && risk <= c.momentum.maxRisk) {
    return {
      label: "MOMENTUM",
      reason: `Opportunity ${opp} ≥ ${c.momentum.minOpportunity}, Momentum ${momentum} ≥ ${c.momentum.minMomentum}, Risk ${risk} ≤ ${c.momentum.maxRisk}.`,
    };
  }
  if (opp >= c.watch.minOpportunity && risk <= c.watch.maxRisk) {
    return { label: "WATCH", reason: `Opportunity ${opp} ≥ ${c.watch.minOpportunity}, Risk ${risk} ≤ ${c.watch.maxRisk}.` };
  }
  return { label: null, reason: "Aucun seuil d'étiquette atteint." };
}

// ─── entry point ────────────────────────────────────────────────────────────

export function scorePair(p: NormalizedPair, now: number = Date.now(), config: ScoringConfig = SCORING_CONFIG): PairScore {
  const ageMinutes = p.pairCreatedAt === null ? null : Math.max(0, (now - p.pairCreatedAt) / 60_000);
  const bondingCurve = p.dexId !== null && config.risk.bondingCurveDexIds.includes(p.dexId);
  const o = config.opportunity;

  const categories: Record<CategoryKey, CategoryScore> = {
    momentum: scoreMomentum(p, ageMinutes, o.momentum),
    volume: scoreVolume(p, ageMinutes, o.volume),
    buyPressure: scoreBuyPressure(p, o.buyPressure),
    liquidity: scoreLiquidity(p, o.liquidity, bondingCurve),
    marketCap: scoreMarketCap(p, o.marketCap),
    age: scoreAge(p, ageMinutes, o.age),
  };

  const opportunityExact = round1(CATEGORY_ORDER.reduce((s, k) => s + categories[k].points, 0));
  const opportunity = Math.round(Math.min(100, opportunityExact));
  const risk = scoreRisk(p, ageMinutes, config.risk, bondingCurve);
  const { label, reason } = pickLabel(opportunity, risk.risk, categories.momentum.points, config.labels);

  return { opportunity, opportunityExact, categories, ...risk, label, labelReason: reason, ageMinutes };
}

export interface ScoredPair {
  pair: NormalizedPair;
  score: PairScore;
}

export function scorePairs(pairs: NormalizedPair[], now: number = Date.now(), config: ScoringConfig = SCORING_CONFIG): ScoredPair[] {
  return pairs.map((pair) => ({ pair, score: scorePair(pair, now, config) }));
}
