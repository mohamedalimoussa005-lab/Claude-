/**
 * Quality (0–100): how credible the observed data and trading activity look.
 * Confidence (LOW / MEDIUM / HIGH): how much the scores can be relied on.
 *
 * Both are separate from Opportunity (setup strength) and Risk. They flag
 * patterns that *may* be artificial or unreliable; they never conclude that
 * a token is botted, and they are not buy signals.
 */

import type { NormalizedPair } from "../domain/normalize.ts";
import type { ScoringConfig } from "./config.ts";
import { interpolate } from "./curve.ts";
import { fmtAge, fmtInt, fmtPct, fmtRatio, fmtShare, fmtUsd, round1 } from "./fmt.ts";
import { IMPORTANT_FIELDS } from "./metrics.ts";
import type { Observed } from "./metrics.ts";

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface QualityDeduction {
  key: string;
  label: string;
  detail: string;
  points: number;
  /** Set when the deduction describes an anomaly (vs. a plain data limitation). */
  anomaly?: string;
}

export interface Anomaly {
  key: string;
  title: string;
  detail: string;
}

export interface Divergence {
  triggered: boolean;
  deduction: number;
  detail: string;
}

export interface QualityResult {
  quality: number;
  deductions: QualityDeduction[];
  anomalies: Anomaly[];
  divergenceH1: Divergence;
  divergenceM5: Divergence;
  /** Sample weight (0…1) used for the 1 h imbalance, reused by Risk. */
  imbalanceWeightH1: number;
}

export interface ConfidencePart {
  label: string;
  detail: string;
  points: number;
  max: number;
}

export interface ConfidenceResult {
  level: ConfidenceLevel;
  points: number;
  parts: ConfidencePart[];
  /** Hard rules that lowered the level. */
  caps: string[];
}

/** Minimum deduction for a flagged pattern to be listed as an anomaly. */
const ANOMALY_MIN_POINTS = 5;

export const ANOMALY = {
  artificial: "Possible artificial activity",
  smallTicket: "Unusually small average transaction size",
  imbalance: "Extreme buy/sell imbalance",
  divergence: "High transaction activity with limited price response",
  turnover: "Extreme volume/liquidity ratio",
  extremeMove: "Extreme price movement",
  liquidityAboveMcap: "Liquidity above market cap",
  windows: "Inconsistent time windows",
} as const;

function detectDivergence(
  tx: number | null,
  buyShare: number | null,
  change: number | null,
  c: ScoringConfig["quality"]["divergenceH1"],
  window: string,
): Divergence {
  const off = { triggered: false, deduction: 0, detail: "" };
  if (tx === null || buyShare === null || change === null) return off;
  if (tx < c.minTxns || buyShare < c.minBuyShare || Math.abs(change) > c.maxPriceChange) return off;
  const deduction = interpolate(c.curve, Math.abs(change));
  if (deduction <= 0) return off;
  return {
    triggered: true,
    deduction,
    detail: `${window} : ${fmtInt(tx)} transactions, ${fmtShare(buyShare)} d'achats, prix ${fmtPct(change)}`,
  };
}

export function computeQuality(p: NormalizedPair, o: Observed, config: ScoringConfig): QualityResult {
  const c = config.quality;
  const deductions: QualityDeduction[] = [];
  const add = (d: QualityDeduction) => {
    if (d.points > 0) deductions.push({ ...d, points: round1(d.points) });
  };

  // A. Average transaction size — the smallest ticket among windows with enough trades.
  const tickets = [
    { w: "1 h", avg: o.avgTicketH1, tx: o.txH1 },
    { w: "5 min", avg: o.avgTicketM5, tx: o.txM5 },
  ].filter((t): t is { w: string; avg: number; tx: number } => t.avg !== null && t.tx !== null && t.tx >= c.smallTicket.minTxns);
  if (tickets.length) {
    const t = tickets.reduce((a, b) => (b.avg < a.avg ? b : a));
    const artificial = t.avg < c.smallTicket.artificialBelowUsd && t.tx >= c.smallTicket.artificialMinTxns;
    add({
      key: "smallTicket",
      label: "Ticket moyen",
      detail: `${fmtUsd(t.avg)} par transaction sur ${t.w} (${fmtInt(t.tx)} transactions)`,
      points: interpolate(c.smallTicket.curve, t.avg),
      anomaly: artificial ? ANOMALY.artificial : ANOMALY.smallTicket,
    });
  }

  // B. Buy/sell imbalance, weighted by sample size.
  const imbalanceWeightH1 = o.txH1 === null ? 0 : interpolate(c.imbalanceWeightH1, o.txH1);
  if (o.buyShareH1 !== null) {
    add({
      key: "imbalanceH1",
      label: "Déséquilibre achats/ventes 1 h",
      detail: `${fmtInt(p.buysH1!)} achats / ${fmtInt(p.sellsH1!)} ventes (${fmtShare(o.buyShareH1)} d'achats)`,
      points: interpolate(c.buyImbalanceH1, o.buyShareH1) * imbalanceWeightH1,
      anomaly: ANOMALY.imbalance,
    });
  }
  if (o.buyShareM5 !== null && o.txM5 !== null) {
    add({
      key: "imbalanceM5",
      label: "Déséquilibre achats/ventes 5 min",
      detail: `${fmtInt(p.buysM5!)} achats / ${fmtInt(p.sellsM5!)} ventes (${fmtShare(o.buyShareM5)} d'achats)`,
      points: interpolate(c.buyImbalanceM5, o.buyShareM5) * interpolate(c.imbalanceWeightM5, o.txM5),
      anomaly: ANOMALY.imbalance,
    });
  }

  // C. Price/activity divergence.
  const divergenceH1 = detectDivergence(o.txH1, o.buyShareH1, p.priceChangeH1, c.divergenceH1, "1 h");
  const divergenceM5 = detectDivergence(o.txM5, o.buyShareM5, p.priceChangeM5, c.divergenceM5, "5 min");
  for (const [key, d] of [["divergenceH1", divergenceH1], ["divergenceM5", divergenceM5]] as const) {
    if (d.triggered) add({ key, label: "Activité sans réaction du prix", detail: d.detail, points: d.deduction, anomaly: ANOMALY.divergence });
  }

  // D. Volume / liquidity.
  if (o.turnoverH1 !== null) {
    add({
      key: "turnover",
      label: "Volume 1 h / liquidité",
      detail: `volume 1 h = ${fmtRatio(o.turnoverH1)} la liquidité`,
      points: interpolate(c.turnover, o.turnoverH1),
      anomaly: ANOMALY.turnover,
    });
  }

  // E. Extreme price movement.
  const long = [p.priceChangeH1, p.priceChangeH6].filter((v): v is number => v !== null);
  if (long.length) {
    const hi = Math.max(...long);
    const lo = Math.min(...long);
    add({ key: "pump", label: "Hausse extrême", detail: `plus forte variation 1 h / 6 h : ${fmtPct(hi)}`, points: interpolate(c.extremePump, hi), anomaly: ANOMALY.extremeMove });
    add({ key: "dump", label: "Chute extrême", detail: `pire variation 1 h / 6 h : ${fmtPct(lo)}`, points: interpolate(c.extremeDump, lo), anomaly: ANOMALY.extremeMove });
  }
  if (p.priceChangeM5 !== null) {
    add({ key: "violentM5", label: "Mouvement violent 5 min", detail: fmtPct(p.priceChangeM5), points: interpolate(c.violentM5, Math.abs(p.priceChangeM5)), anomaly: ANOMALY.extremeMove });
  }

  // Data consistency.
  if (p.liquidityUsd !== null && p.marketCap !== null && p.liquidityUsd > p.marketCap) {
    add({
      key: "liqAboveMcap",
      label: "Liquidité > market cap",
      detail: `liquidité ${fmtUsd(p.liquidityUsd)} > market cap ${fmtUsd(p.marketCap)}`,
      points: c.liquidityAboveMcap,
      anomaly: ANOMALY.liquidityAboveMcap,
    });
  }
  if (o.windowIssues.length) {
    add({
      key: "windows",
      label: "Incohérence entre fenêtres",
      detail: o.windowIssues.join(", "),
      points: Math.min(c.windowInconsistency.max, o.windowIssues.length * c.windowInconsistency.perIssue),
      anomaly: ANOMALY.windows,
    });
  }

  // Data limitations (not anomalies).
  if (o.txH1 !== null) add({ key: "fewTxns", label: "Échantillon de transactions faible", detail: `${fmtInt(o.txH1)} transactions / 1 h`, points: interpolate(c.fewTxns, o.txH1) });
  if (o.ageMinutes !== null) add({ key: "veryNew", label: "Historique très court", detail: fmtAge(o.ageMinutes), points: interpolate(c.veryNew, o.ageMinutes) });
  if (p.liquidityUsd === null) {
    add({
      key: "missingLiquidity",
      label: "Liquidité absente",
      detail: o.bondingCurve ? "pump.fun bonding curve : liquidity.usd non fourni" : "liquidity.usd absent",
      points: c.missingLiquidity,
    });
  }
  const missing = IMPORTANT_FIELDS.filter(([f]) => p[f] === null).map(([, path]) => path);
  if (missing.length) {
    add({ key: "missing", label: "Données manquantes", detail: missing.join(", "), points: Math.min(c.missingField.max, missing.length * c.missingField.perField) });
  }

  deductions.sort((a, b) => b.points - a.points);
  const total = deductions.reduce((s, d) => s + d.points, 0);

  // One anomaly per title, keeping the strongest detail.
  const anomalies: Anomaly[] = [];
  for (const d of deductions) {
    if (!d.anomaly || d.points < ANOMALY_MIN_POINTS) continue;
    const existing = anomalies.find((a) => a.title === d.anomaly);
    if (existing) existing.detail += ` · ${d.detail}`;
    else anomalies.push({ key: d.key, title: d.anomaly, detail: d.detail });
  }

  return {
    quality: Math.max(0, Math.round(100 - total)),
    deductions,
    anomalies,
    divergenceH1,
    divergenceM5,
    imbalanceWeightH1,
  };
}

export function computeConfidence(p: NormalizedPair, o: Observed, quality: QualityResult, config: ScoringConfig): ConfidenceResult {
  const c = config.confidence;
  const fields = IMPORTANT_FIELDS.length + 1;
  const present = IMPORTANT_FIELDS.filter(([f]) => p[f] !== null).length + (p.liquidityUsd !== null ? 1 : 0);
  const completeness = present / fields;
  const maxOf = (curve: readonly (readonly [number, number])[]) => Math.max(...curve.map(([, y]) => y));

  const parts: ConfidencePart[] = [
    { label: "Données disponibles", detail: `${present} / ${fields} champs`, points: interpolate(c.completeness, completeness), max: maxOf(c.completeness) },
    {
      label: "Âge du token",
      detail: o.ageMinutes === null ? "pairCreatedAt absent" : fmtAge(o.ageMinutes),
      points: o.ageMinutes === null ? 0 : interpolate(c.age, o.ageMinutes),
      max: maxOf(c.age),
    },
    {
      label: "Nombre de transactions",
      detail: o.txH1 === null ? "absent" : `${fmtInt(o.txH1)} / 1 h`,
      points: o.txH1 === null ? 0 : interpolate(c.txns, o.txH1),
      max: maxOf(c.txns),
    },
    {
      label: "Liquidité",
      detail: p.liquidityUsd === null ? "absente" : fmtUsd(p.liquidityUsd),
      points: p.liquidityUsd === null ? 0 : p.liquidityUsd >= c.liquidity.minUsd ? c.liquidity.full : c.liquidity.partial,
      max: c.liquidity.full,
    },
    {
      label: "Cohérence des fenêtres",
      detail: o.windowIssues.length ? o.windowIssues.join(", ") : "cohérentes",
      points: o.windowIssues.length ? 0 : c.consistency,
      max: c.consistency,
    },
  ];
  const penalty = Math.min(c.maxAnomalyPenalty, quality.anomalies.length * c.perAnomaly);
  if (penalty > 0) parts.push({ label: "Anomalies détectées", detail: `${quality.anomalies.length} anomalie(s)`, points: -penalty, max: 0 });
  for (const part of parts) part.points = round1(part.points);

  const points = Math.max(0, Math.round(parts.reduce((s, x) => s + x.points, 0)));
  let level: ConfidenceLevel = points >= c.high ? "HIGH" : points >= c.medium ? "MEDIUM" : "LOW";

  const caps: string[] = [];
  const capTo = (max: ConfidenceLevel, reason: string) => {
    const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    if (rank[level] > rank[max]) {
      level = max;
      caps.push(reason);
    }
  };
  if (o.ageMinutes !== null && o.ageMinutes < c.lowIfAgeBelowMinutes) capTo("LOW", `token de moins de ${c.lowIfAgeBelowMinutes} min`);
  if (o.ageMinutes === null) capTo("MEDIUM", "âge inconnu");
  else if (o.ageMinutes < c.mediumMaxIfAgeBelowMinutes) capTo("MEDIUM", `token de moins de ${c.mediumMaxIfAgeBelowMinutes} min`);
  if (c.mediumMaxIfNoLiquidity && p.liquidityUsd === null) capTo("MEDIUM", "liquidité absente");
  if (quality.quality < c.lowIfQualityBelow) capTo("LOW", `Quality ${quality.quality} < ${c.lowIfQualityBelow}`);
  else if (quality.quality < c.mediumMaxIfQualityBelow) capTo("MEDIUM", `Quality ${quality.quality} < ${c.mediumMaxIfQualityBelow}`);

  return { level, points, parts, caps };
}
