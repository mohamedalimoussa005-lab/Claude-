/** Statistics over KNOWN closed rounds only. Pure; nothing here sees unknown or open positions. */

import type { SmartMoneyThresholds } from "../config.ts";
import type { Round } from "./types.ts";

const WEEK_MS = 7 * 86_400_000;
/** Results closer to 0 than this (SOL or USD) are float noise: a flat round, neither a win nor a loss. */
export const FLAT_EPSILON = 1e-9;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Wilson score interval for k successes out of n. null when n = 0. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export interface WinRate {
  /** KNOWN closed rounds (any quote). */
  n: number;
  wins: number;
  losses: number;
  flat: number;
  /** wins / n; null when n = 0. */
  rate: number | null;
  /** Confidence interval of the rate. */
  interval: [number, number] | null;
  /** "insufficient": fewer known closed rounds than required, the rate is descriptive only. */
  sample: "sufficient" | "insufficient";
  minRequired: number;
}

export interface Consistency {
  /** SOL-quoted KNOWN rounds the measures are computed on. */
  n: number;
  totalPnlSol: number;
  medianRoi: number | null;
  meanRoi: number | null;
  /** Share of the gross profit made by the single best round (1 = all of it). null without any profit. */
  bestShareOfGrossProfit: number | null;
  /** Total PnL without the single best round: shows how luck-dependent the result is. */
  pnlWithoutBestSol: number | null;
  /** Largest peak-to-trough fall of the cumulative realized PnL (≥ 0), in SOL. */
  maxDrawdownSol: number;
  longestLossStreak: number;
  activeWeeks: number;
  profitableWeeks: number;
  medianHoldSeconds: number | null;
}

export function winRate(known: Round[], t: Pick<SmartMoneyThresholds, "minClosedPositions" | "wilsonZ">): WinRate {
  const priced = known.filter((r) => r.pnl !== null);
  const wins = priced.filter((r) => (r.pnl as number) > FLAT_EPSILON).length;
  const losses = priced.filter((r) => (r.pnl as number) < -FLAT_EPSILON).length;
  const n = priced.length;
  return {
    n, wins, losses, flat: n - wins - losses, rate: n ? wins / n : null, interval: wilson(wins, n, t.wilsonZ),
    sample: n >= t.minClosedPositions ? "sufficient" : "insufficient", minRequired: t.minClosedPositions,
  };
}

export function consistency(knownSol: Round[]): Consistency {
  const rs = [...knownSol].sort((a, b) => a.closedAt - b.closedAt);
  const pnls = rs.map((r) => r.pnl as number);
  const rois = rs.map((r) => r.roi).filter((x): x is number => x !== null);
  const total = pnls.reduce((a, b) => a + b, 0);
  const gross = pnls.filter((p) => p > FLAT_EPSILON).reduce((a, b) => a + b, 0);
  const best = pnls.length ? Math.max(...pnls) : null;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let longest = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    streak = p < -FLAT_EPSILON ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const weeks = new Map<number, number>();
  for (const r of rs) weeks.set(Math.floor(r.closedAt / WEEK_MS), (weeks.get(Math.floor(r.closedAt / WEEK_MS)) ?? 0) + (r.pnl as number));
  return {
    n: rs.length,
    totalPnlSol: total,
    medianRoi: median(rois),
    meanRoi: rois.length ? rois.reduce((a, b) => a + b, 0) / rois.length : null,
    bestShareOfGrossProfit: gross > 0 && best !== null ? best / gross : null,
    pnlWithoutBestSol: best !== null && rs.length >= 2 ? total - best : null,
    maxDrawdownSol: dd,
    longestLossStreak: longest,
    activeWeeks: weeks.size,
    profitableWeeks: [...weeks.values()].filter((v) => v > FLAT_EPSILON).length,
    medianHoldSeconds: median(rs.map((r) => r.holdSeconds)),
  };
}
