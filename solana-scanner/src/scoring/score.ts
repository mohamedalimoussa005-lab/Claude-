/**
 * Scoring engine: turns one NormalizedPair into independent measures.
 *
 *   - Opportunity (0–100): strength of the observed setup and momentum,
 *     split into six categories (see config.ts for every rule).
 *   - Risk (0–100): sum of risk factors, capped.
 *   - Quality (0–100) and Confidence (LOW/MEDIUM/HIGH): credibility of the
 *     data and of the activity (see quality.ts).
 *
 * All are descriptions of current DEX Screener data, not predictions.
 * Pure function of (pair, now, config): no I/O, deterministic, testable.
 *
 * A missing input is never read as 0: the item it feeds earns no points,
 * is flagged `missing`, and the gap raises the Risk score.
 */

import type { NormalizedPair } from "../domain/normalize.ts";
import { SCORING_CONFIG } from "./config.ts";
import type { Curve, ScoringConfig } from "./config.ts";
import { interpolate } from "./curve.ts";
import { ABSENT, fmtAge, fmtInt, fmtPct, fmtPts, fmtRatio, fmtShare, fmtUsd, round1 } from "./fmt.ts";
import { IMPORTANT_FIELDS, observe } from "./metrics.ts";
import type { Observed } from "./metrics.ts";
import { computeConfidence, computeQuality } from "./quality.ts";
import type { Anomaly, ConfidenceResult, QualityResult } from "./quality.ts";

export { interpolate };
export type { Anomaly, ConfidenceLevel, ConfidenceResult, QualityResult } from "./quality.ts";

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
  /** Quality score, integer 0–100, with its deductions and anomalies. */
  quality: number;
  qualityDetail: QualityResult;
  confidence: ConfidenceResult;
  signals: Signals;
  /** Derived observations (average ticket, buy share, turnover…). */
  observed: Observed;
}

export interface Signals {
  positive: string[];
  negative: string[];
  anomalies: Anomaly[];
}

// ─── helpers ────────────────────────────────────────────────────────────────

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

/**
 * Multiplies an item's points by `factor` (< 1) and records why in its note.
 * Used when activity looks unreliable: the raw value is untouched, only the
 * points it earns are reduced.
 */
function discount(item: ScoreItem, factor: number, reason: string): void {
  if (factor >= 1 || item.missing || item.points <= 0) return;
  const after = item.points * factor;
  const msg = `${reason} : ×${factor.toFixed(2)}, ${item.points.toFixed(1)} → ${after.toFixed(1)} pts.`;
  item.note = item.note ? `${item.note} ${msg}` : msg;
  item.points = after;
}

/** Context shared by the category scorers. */
interface Ctx {
  o: Observed;
  q: QualityResult;
  /** Multiplier for count-based items when the average ticket is very small. */
  ticketFactor: number;
  ticketReason: string;
}

// ─── Opportunity categories ─────────────────────────────────────────────────

function scoreMomentum(p: NormalizedPair, { o }: Ctx, c: ScoringConfig["opportunity"]["momentum"]): CategoryScore {
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
    const avg5m = p.priceChangeH1 / (o.h1WindowMinutes / 5);
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

function scoreVolume(p: NormalizedPair, { o }: Ctx, c: ScoringConfig["opportunity"]["volume"], adj: ScoringConfig["opportunity"]["adjustments"]): CategoryScore {
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
    const avg5m = p.volumeH1 / (o.h1WindowMinutes / 5);
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

  // A huge volume relative to liquidity is not automatically positive.
  if (o.turnoverH1 !== null) {
    const f = interpolate(adj.turnover, o.turnoverH1);
    const why = `Volume 1 h = ${fmtRatio(o.turnoverH1)} la liquidité`;
    for (const it of items) if (it.key === "m5" || it.key === "h1") discount(it, f, why);
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

function scoreBuyPressure(
  p: NormalizedPair,
  { o, q, ticketFactor, ticketReason }: Ctx,
  c: ScoringConfig["opportunity"]["buyPressure"],
  adj: ScoringConfig["opportunity"]["adjustments"],
): CategoryScore {
  const txH1 = o.txH1;
  const items = [
    ratioItem("m5", "Achats vs ventes 5 min", p.buysM5, p.sellsM5, c.ratioM5, c.ratioM5Max, c.confidenceM5, ["txns.m5.buys", "txns.m5.sells"]),
    ratioItem("h1", "Achats vs ventes 1 h", p.buysH1, p.sellsH1, c.ratioH1, c.ratioH1Max, c.confidenceH1, ["txns.h1.buys", "txns.h1.sells"]),
    curveItem("activity", "Nombre de transactions 1 h", txH1, c.activity, c.activityMax, fmtInt, ["txns.h1.buys", "txns.h1.sells"]),
  ];
  // Many tiny transactions must not be enough for a strong buy-pressure score.
  for (const it of items) discount(it, ticketFactor, ticketReason);
  if (q.divergenceH1.triggered || q.divergenceM5.triggered) {
    const d = q.divergenceH1.triggered ? q.divergenceH1 : q.divergenceM5;
    for (const it of items) if (it.key !== "activity") discount(it, adj.divergence, `Activité sans réaction du prix (${d.detail})`);
  }
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

function scoreAge({ o, ticketFactor, ticketReason }: Ctx, c: ScoringConfig["opportunity"]["age"]): CategoryScore {
  const ageMin = o.ageMinutes;
  const txH1 = o.txH1;
  if (ageMin === null || txH1 === null) {
    const missing = [ageMin === null && "pairCreatedAt", txH1 === null && "txns.h1"].filter(Boolean) as string[];
    return category("age", c.max, [
      { key: "age", label: "Âge × activité réelle", input: ABSENT, points: 0, max: c.max, missing: true, note: absentNote(missing) },
    ]);
  }
  const ageF = interpolate(c.ageCurve, ageMin);
  const actF = interpolate(c.activityCurve, txH1);
  const item: ScoreItem =
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
    };
  discount(item, ticketFactor, ticketReason);
  return category("age", c.max, [item]);
}

// ─── Risk ───────────────────────────────────────────────────────────────────

function scoreRisk(p: NormalizedPair, o: Observed, q: QualityResult, c: ScoringConfig["risk"]) {
  const factors: RiskFactor[] = [];
  const add = (key: string, label: string, input: string, points: number) => {
    if (points > 0) factors.push({ key, label, input, points: round1(points) });
  };

  if (p.liquidityUsd === null) {
    if (o.bondingCurve) add("bondingCurve", "pump.fun bonding curve sans liquidity.usd", `dex ${p.dexId}`, c.bondingCurveNoLiquidity);
    else add("missingLiquidity", "Liquidité absente", "liquidity.usd absent", c.missingLiquidity);
  } else {
    add("lowLiquidity", "Liquidité faible", fmtUsd(p.liquidityUsd), interpolate(c.lowLiquidity, p.liquidityUsd));
  }

  if (p.marketCap !== null) add("lowMarketCap", "Market cap extrêmement faible", fmtUsd(p.marketCap), interpolate(c.lowMarketCap, p.marketCap));

  if (o.txH1 !== null) add("fewTxns", "Très peu de transactions", `${fmtInt(o.txH1)} transactions / 1 h`, interpolate(c.fewTransactions, o.txH1));

  const drops = [p.priceChangeH1, p.priceChangeH6].filter((v): v is number => v !== null);
  if (drops.length) {
    const worst = Math.min(...drops);
    add("crash", "Chute de prix extrême", `pire variation 1 h / 6 h : ${fmtPct(worst)}`, interpolate(c.priceCrash, worst));
  }
  if (p.priceChangeM5 !== null) add("crashM5", "Chute brutale sur 5 min", fmtPct(p.priceChangeM5), interpolate(c.priceCrashM5, p.priceChangeM5));

  if (o.turnoverH1 !== null) {
    add("turnover", "Volume anormal par rapport à la liquidité", `volume 1 h = ${fmtRatio(o.turnoverH1)} la liquidité`, interpolate(c.abnormalTurnover, o.turnoverH1));
  }

  if (p.priceChangeM5 !== null)
    add("violentM5", "Mouvement violent sur 5 min", fmtPct(p.priceChangeM5), interpolate(c.violentM5, Math.abs(p.priceChangeM5)));
  if (p.priceChangeH1 !== null)
    add("violentH1", "Mouvement violent sur 1 h", fmtPct(p.priceChangeH1), interpolate(c.violentH1, Math.abs(p.priceChangeH1)));

  if (o.ageMinutes !== null) add("veryNew", "Paire très récente", fmtAge(o.ageMinutes), interpolate(c.veryNew, o.ageMinutes));

  if (o.avgTicketH1 !== null && o.txH1 !== null && o.txH1 >= c.smallTicket.minTxns) {
    add("smallTicket", "Ticket moyen anormalement faible", `${fmtUsd(o.avgTicketH1)} par transaction (1 h)`, interpolate(c.smallTicket.curve, o.avgTicketH1));
  }
  if (o.buyShareH1 !== null) {
    add(
      "imbalance",
      "Déséquilibre achats/ventes extrême",
      `${fmtShare(o.buyShareH1)} d'achats sur ${fmtInt(o.txH1!)} transactions (1 h)`,
      interpolate(c.buyImbalance, o.buyShareH1) * q.imbalanceWeightH1,
    );
  }
  if (q.divergenceH1.triggered) add("divergence", "Activité sans réaction du prix", q.divergenceH1.detail, c.divergence);

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

function pickLabel(
  opp: number,
  risk: number,
  momentum: number,
  quality: number,
  confidence: ConfidenceResult["level"],
  c: ScoringConfig["labels"],
): { label: Label | null; reason: string } {
  if (risk >= c.highRisk.minRisk) return { label: "HIGH RISK", reason: `Risk ${risk} ≥ ${c.highRisk.minRisk}.` };
  const m = c.momentum;
  const blocked: string[] = [];
  if (opp >= m.minOpportunity && momentum >= m.minMomentum && risk <= m.maxRisk) {
    if (quality < m.minQuality) blocked.push(`Quality ${quality} < ${m.minQuality}`);
    if (!m.allowLowConfidence && confidence === "LOW") blocked.push("Confidence LOW");
    if (!blocked.length) {
      return {
        label: "MOMENTUM",
        reason: `Opportunity ${opp} ≥ ${m.minOpportunity}, Momentum ${momentum} ≥ ${m.minMomentum}, Risk ${risk} ≤ ${m.maxRisk}, Quality ${quality} ≥ ${m.minQuality}, Confidence ${confidence}.`,
      };
    }
  }
  const w = c.watch;
  const note = blocked.length ? ` (MOMENTUM non attribué : ${blocked.join(", ")})` : "";
  if (opp >= w.minOpportunity && risk <= w.maxRisk && quality >= w.minQuality) {
    return { label: "WATCH", reason: `Opportunity ${opp} ≥ ${w.minOpportunity}, Risk ${risk} ≤ ${w.maxRisk}, Quality ${quality} ≥ ${w.minQuality}.${note}` };
  }
  const why = opp >= w.minOpportunity && risk <= w.maxRisk && quality < w.minQuality ? ` Quality ${quality} < ${w.minQuality}.` : "";
  return { label: null, reason: `Aucun seuil d'étiquette atteint.${why}${note}` };
}

// ─── Signals ────────────────────────────────────────────────────────────────

function buildSignals(categories: Record<CategoryKey, CategoryScore>, risk: RiskFactor[], missing: string[], q: QualityResult): Signals {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const k of CATEGORY_ORDER) {
    for (const it of categories[k].items) {
      if (it.missing) continue;
      const share = it.max > 0 ? it.points / it.max : 0;
      if (share >= 0.8 && it.max >= 3) positive.push(`${it.label} : ${it.input}`);
      else if (share <= 0.25 && it.max >= 3) negative.push(`${it.label} : ${it.input} (${it.points.toFixed(1)}/${it.max})`);
    }
  }
  if (q.quality >= 80) positive.push(`Activité cohérente : Quality ${q.quality}/100`);
  for (const f of risk) negative.push(`${f.label} : ${f.input} (+${f.points} risk)`);
  if (missing.length) negative.push(`Données absentes : ${missing.join(", ")}`);
  return { positive, negative, anomalies: q.anomalies };
}

// ─── entry point ────────────────────────────────────────────────────────────

export function scorePair(p: NormalizedPair, now: number = Date.now(), config: ScoringConfig = SCORING_CONFIG): PairScore {
  const observed = observe(p, now, config);
  const qualityDetail = computeQuality(p, observed, config);
  const confidence = computeConfidence(p, observed, qualityDetail, config);
  const oc = config.opportunity;

  const st = oc.adjustments.smallTicket;
  const ticketApplies = observed.avgTicketH1 !== null && observed.txH1 !== null && observed.txH1 >= st.minTxns;
  const ctx: Ctx = {
    o: observed,
    q: qualityDetail,
    ticketFactor: ticketApplies ? interpolate(st.curve, observed.avgTicketH1!) : 1,
    ticketReason: ticketApplies ? `Ticket moyen ${fmtUsd(observed.avgTicketH1!)} / transaction sur 1 h` : "",
  };

  const categories: Record<CategoryKey, CategoryScore> = {
    momentum: scoreMomentum(p, ctx, oc.momentum),
    volume: scoreVolume(p, ctx, oc.volume, oc.adjustments),
    buyPressure: scoreBuyPressure(p, ctx, oc.buyPressure, oc.adjustments),
    liquidity: scoreLiquidity(p, oc.liquidity, observed.bondingCurve),
    marketCap: scoreMarketCap(p, oc.marketCap),
    age: scoreAge(ctx, oc.age),
  };

  const opportunityExact = round1(CATEGORY_ORDER.reduce((s, k) => s + categories[k].points, 0));
  const opportunity = Math.round(Math.min(100, opportunityExact));
  const risk = scoreRisk(p, observed, qualityDetail, config.risk);
  const { label, reason } = pickLabel(
    opportunity,
    risk.risk,
    categories.momentum.points,
    qualityDetail.quality,
    confidence.level,
    config.labels,
  );

  return {
    opportunity,
    opportunityExact,
    categories,
    ...risk,
    label,
    labelReason: reason,
    ageMinutes: observed.ageMinutes,
    quality: qualityDetail.quality,
    qualityDetail,
    confidence,
    signals: buildSignals(categories, risk.riskFactors, risk.missingFields, qualityDetail),
    observed,
  };
}

export interface ScoredPair {
  pair: NormalizedPair;
  score: PairScore;
}

export function scorePairs(pairs: NormalizedPair[], now: number = Date.now(), config: ScoringConfig = SCORING_CONFIG): ScoredPair[] {
  return pairs.map((pair) => ({ pair, score: scorePair(pair, now, config) }));
}
