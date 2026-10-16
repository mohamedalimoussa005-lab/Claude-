/**
 * SMART MONEY TRACKER configuration. No secret here, no network setting:
 * phases 0-2 never call an API. Every threshold is provisional and
 * overridable (environment or `loadConfig(env, overrides)`).
 */

import { join } from "node:path";

export interface SmartMoneyThresholds {
  /** Known closed positions needed before a win rate counts as a sample. */
  minClosedPositions: number;
  /** Length of the out-of-sample window used by the (later) walk-forward validation. */
  walkForwardDays: number;
  /** z of the win-rate confidence interval (1.96 = 95 %). */
  wilsonZ: number;
  /** A position is closed when what is left is at most this share of its peak holding (rounding dust). */
  dustRatio: number;
  /** SOL moves smaller than this (fee, tip excluded) are rent / noise, not a quote leg — used when rent could not be separated. */
  solNoiseSol: number;
  /** Same, once rent has been identified and removed: only dust is ignored. */
  solDustSol: number;
  /** Stablecoin moves smaller than this (USD) are noise, not a quote leg. */
  stableNoiseUsd: number;
}

export interface SmartMoneyConfig {
  thresholds: SmartMoneyThresholds;
  /** Accounts whose incoming lamports are a priority tip (Jito…). Empty = tips are not isolated. Never guessed. */
  tipAccounts: string[];
  /** Persistent memory directory (git-ignored). */
  dir: string;
  /** Version of the tracking criteria, written in every event. */
  criteriaVersion: string;
}

export const DEFAULT_THRESHOLDS: SmartMoneyThresholds = {
  minClosedPositions: 20,
  walkForwardDays: 14,
  wilsonZ: 1.96,
  dustRatio: 0.001,
  solNoiseSol: 0.005,
  solDustSol: 0.0001,
  stableNoiseUsd: 0.01,
};

export const DEFAULT_DIR = join("data", "smart-money");

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<SmartMoneyConfig> = {}): SmartMoneyConfig {
  const t = DEFAULT_THRESHOLDS;
  const base: SmartMoneyConfig = {
    thresholds: {
      ...t,
      minClosedPositions: positive("SMART_MONEY_MIN_CLOSED", env.SMART_MONEY_MIN_CLOSED, t.minClosedPositions),
      walkForwardDays: positive("SMART_MONEY_WALKFORWARD_DAYS", env.SMART_MONEY_WALKFORWARD_DAYS, t.walkForwardDays),
    },
    tipAccounts: (env.SMART_MONEY_TIP_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    dir: env.SMART_MONEY_DIR?.trim() || DEFAULT_DIR,
    criteriaVersion: "criteria/0-provisional",
  };
  return { ...base, ...overrides, thresholds: { ...base.thresholds, ...(overrides.thresholds ?? {}) } };
}
