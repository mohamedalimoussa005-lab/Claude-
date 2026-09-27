/**
 * OLD (step 4 RPC path) vs NEW (step 4.2 history layer) on the same token:
 * what each path could establish. Descriptive only — nothing here feeds a
 * score.
 */

import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import type { WalletIntel } from "./intel.ts";

export interface IntelSummary {
  walletsAnalyzed: number;
  historyComplete: number;
  positionsReconstructed: number;
  realizedPositions: number;
  botSignals: number;
  walletAgeKnown: number;
  fundingKnown: number;
  creatorLinks: number;
  /** Wallets with enough evaluable positions for a MEDIUM or HIGH Confidence input. */
  confidenceInputsAvailable: number;
}

export function summarizeIntel(intel: WalletIntel, c: WalletConfig = WALLET_CONFIG): IntelSummary {
  const t = intel.tracked;
  const creatorFlag = new Set(["creator", "fundedByCreator", "sameFunderAsCreator"]);
  const recipients = new Set(intel.creatorDistribution?.recipients ?? []);
  return {
    walletsAnalyzed: t.length,
    historyComplete: t.filter((w) => w.profile.facts.historyComplete && w.profile.facts.trades !== null).length,
    positionsReconstructed: t.reduce((s, w) => s + (w.profile.metrics?.positions.length ?? 0), 0),
    realizedPositions: t.reduce((s, w) => s + (w.profile.metrics?.positions.filter((p) => p.tokensOut > 0).length ?? 0), 0),
    botSignals: t.filter((w) => w.profile.flags.some((f) => f.key === "busy")).length,
    walletAgeKnown: t.filter((w) => w.profile.facts.firstSeen !== null).length,
    fundingKnown: t.filter((w) => w.profile.facts.funder !== null).length,
    creatorLinks: t.filter((w) => w.profile.flags.some((f) => creatorFlag.has(f.key)) || recipients.has(w.address)).length,
    confidenceInputsAvailable: t.filter((w) => w.profile.facts.trades !== null && (w.profile.metrics?.evaluated ?? 0) >= c.confidence.mediumMinPositions).length,
  };
}

export interface ComparisonRow {
  metric: keyof IntelSummary;
  old: number;
  new: number;
  delta: number;
}

export function compareIntel(oldIntel: WalletIntel, newIntel: WalletIntel, c: WalletConfig = WALLET_CONFIG): ComparisonRow[] {
  const a = summarizeIntel(oldIntel, c);
  const b = summarizeIntel(newIntel, c);
  return (Object.keys(a) as (keyof IntelSummary)[]).map((metric) => ({ metric, old: a[metric], new: b[metric], delta: b[metric] - a[metric] }));
}
