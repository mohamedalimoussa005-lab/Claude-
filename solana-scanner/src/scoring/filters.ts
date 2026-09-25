/**
 * Table filters. Each bound is optional (null = not applied).
 *
 * When a bound is set and the pair lacks the value it tests (e.g. no
 * liquidity.usd with a minimum liquidity set), the pair is excluded: an absent
 * value can't be shown to satisfy the bound, and it is never read as 0.
 */

import type { ScoredPair } from "./score.ts";

export interface ScoreFilters {
  maxAgeMinutes: number | null;
  minMarketCap: number | null;
  maxMarketCap: number | null;
  minLiquidity: number | null;
  /** Minimum volume.h1 (USD). */
  minVolumeH1: number | null;
  minOpportunity: number | null;
  maxRisk: number | null;
  minQuality: number | null;
}

export const NO_FILTERS: ScoreFilters = {
  maxAgeMinutes: null,
  minMarketCap: null,
  maxMarketCap: null,
  minLiquidity: null,
  minVolumeH1: null,
  minOpportunity: null,
  maxRisk: null,
  minQuality: null,
};

const atLeast = (v: number | null, min: number | null) => min === null || (v !== null && v >= min);
const atMost = (v: number | null, max: number | null) => max === null || (v !== null && v <= max);

export function matchesFilters({ pair, score }: ScoredPair, f: ScoreFilters): boolean {
  return (
    atMost(score.ageMinutes, f.maxAgeMinutes) &&
    atLeast(pair.marketCap, f.minMarketCap) &&
    atMost(pair.marketCap, f.maxMarketCap) &&
    atLeast(pair.liquidityUsd, f.minLiquidity) &&
    atLeast(pair.volumeH1, f.minVolumeH1) &&
    atLeast(score.opportunity, f.minOpportunity) &&
    atMost(score.risk, f.maxRisk) &&
    atLeast(score.quality, f.minQuality)
  );
}

export function applyFilters(rows: ScoredPair[], f: ScoreFilters): ScoredPair[] {
  return rows.filter((r) => matchesFilters(r, f));
}
