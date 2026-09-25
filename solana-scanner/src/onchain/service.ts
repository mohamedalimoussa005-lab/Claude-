/**
 * Pipeline glue: DEX Screener → filters → Opportunity / Risk / Quality →
 * candidate selection → (only then) on-chain analysis.
 */

import type { ScoredPair } from "../scoring/score.ts";
import { analyzeOnchain } from "./analyze.ts";
import type { OnchainAnalysis } from "./analyze.ts";
import { collectOnchain } from "./collect.ts";
import type { OnchainRpc } from "./collect.ts";
import { ONCHAIN_CONFIG } from "./config.ts";
import type { OnchainConfig } from "./config.ts";
import type { OnchainData } from "./types.ts";

export interface OnchainResult {
  data: OnchainData;
  analysis: OnchainAnalysis;
}

/**
 * Rows worth an on-chain look: already filtered by the user, then the best
 * Opportunity scores among those whose DEX risk and quality are acceptable.
 */
export function selectCandidates(rows: ScoredPair[], config: OnchainConfig = ONCHAIN_CONFIG): ScoredPair[] {
  const c = config.candidates;
  const seen = new Set<string>();
  return [...rows]
    .filter((r) => r.score.opportunity >= c.minOpportunity && r.score.risk <= c.maxDexRisk && r.score.quality >= c.minQuality)
    .sort((a, b) => b.score.opportunity - a.score.opportunity)
    .filter((r) => (seen.has(r.pair.tokenAddress) ? false : (seen.add(r.pair.tokenAddress), true)))
    .slice(0, c.max);
}

/** Analyses tokens with a per-token result cache; RPC calls are cached separately by the client. */
export class OnchainService {
  private readonly rpc: OnchainRpc;
  private readonly config: OnchainConfig;
  private readonly results = new Map<string, { at: number; value: Promise<OnchainResult> }>();

  constructor(rpc: OnchainRpc, config: OnchainConfig = ONCHAIN_CONFIG) {
    this.rpc = rpc;
    this.config = config;
  }

  analyze(row: ScoredPair, force = false): Promise<OnchainResult> {
    const key = row.pair.tokenAddress;
    const hit = this.results.get(key);
    if (hit && !force && Date.now() - hit.at < this.config.cacheTtlMs.holders) return hit.value;
    const value = collectOnchain(this.rpc, { mint: key, pairAddress: row.pair.pairAddress, dexId: row.pair.dexId }, this.config).then((data) => ({
      data,
      analysis: analyzeOnchain(data, this.config),
    }));
    this.results.set(key, { at: Date.now(), value });
    value.catch(() => this.results.delete(key));
    return value;
  }
}
