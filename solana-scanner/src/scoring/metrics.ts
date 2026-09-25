/**
 * Derived observations shared by the Opportunity, Risk, Quality and
 * Confidence computations. Reads the NormalizedPair, never modifies it.
 * Every derived value is null when an input it needs is absent (or a
 * denominator is 0): nothing is inferred from missing data.
 */

import type { NormalizedPair } from "../domain/normalize.ts";
import type { ScoringConfig } from "./config.ts";

export interface Observed {
  /** Pair age in minutes at scoring time. */
  ageMinutes: number | null;
  /** Minutes actually covered by the "h1" window (the pair's age if younger). */
  h1WindowMinutes: number;
  txM5: number | null;
  txH1: number | null;
  /** buys / (buys + sells). */
  buyShareM5: number | null;
  buyShareH1: number | null;
  /** Approximate average transaction size in USD: volume / transactions. */
  avgTicketM5: number | null;
  avgTicketH1: number | null;
  /** volume.h1 / liquidity.usd. */
  turnoverH1: number | null;
  /** DEX id is a pump.fun bonding curve. */
  bondingCurve: boolean;
  /** Human-readable inconsistencies between time windows. */
  windowIssues: string[];
}

const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
const div = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : a / b);

export function observe(p: NormalizedPair, now: number, config: ScoringConfig): Observed {
  const ageMinutes = p.pairCreatedAt === null ? null : Math.max(0, (now - p.pairCreatedAt) / 60_000);
  const txM5 = sum(p.buysM5, p.sellsM5);
  const txH1 = sum(p.buysH1, p.sellsH1);
  const tol = 1 + config.quality.windowInconsistency.tolerance;

  const windowIssues: string[] = [];
  const bigger = (a: number | null, b: number | null, msg: string) => {
    if (a !== null && b !== null && a > b * tol) windowIssues.push(msg);
  };
  bigger(p.volumeM5, p.volumeH1, "volume 5 min > volume 1 h");
  bigger(p.volumeH1, p.volumeH6, "volume 1 h > volume 6 h");
  bigger(p.volumeH6, p.volumeH24, "volume 6 h > volume 24 h");
  if (txM5 !== null && txH1 !== null && txM5 > txH1) windowIssues.push("transactions 5 min > transactions 1 h");

  return {
    ageMinutes,
    h1WindowMinutes: ageMinutes === null ? 60 : Math.min(60, Math.max(5, ageMinutes)),
    txM5,
    txH1,
    buyShareM5: div(p.buysM5, txM5),
    buyShareH1: div(p.buysH1, txH1),
    avgTicketM5: div(p.volumeM5, txM5),
    avgTicketH1: div(p.volumeH1, txH1),
    turnoverH1: div(p.volumeH1, p.liquidityUsd),
    bondingCurve: p.dexId !== null && config.risk.bondingCurveDexIds.includes(p.dexId),
    windowIssues,
  };
}

/** Fields whose absence lowers Quality, Confidence and raises Risk. */
export const IMPORTANT_FIELDS: [keyof NormalizedPair, string][] = [
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
