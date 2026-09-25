/**
 * Solana discovery pipeline:
 *
 *   1. Discover recently active Solana tokens from three 60 req/min feeds
 *      (latest profiles, latest boosts, top boosts).
 *   2. Fetch their pairs in batches of 30 via /tokens/v1/solana/{addresses}.
 *   3. Normalise, keep only Solana pairs whose *base* token is a discovered
 *      token (priceUsd, marketCap and fdv refer to the base token), dedupe.
 *
 * A failing source or batch doesn't abort the scan: the failure is reported in
 * `errors` and whatever else succeeded is still returned.
 */

import { DexScreenerError, MAX_ADDRESSES_PER_CALL } from "../api/dexscreener.ts";
import type { DexScreenerClient } from "../api/dexscreener.ts";
import { extractPairs, extractTokenRefs, normalizePair } from "./normalize.ts";
import type { NormalizedPair } from "./normalize.ts";

export const SOLANA = "solana";

export type ScanClient = Pick<
  DexScreenerClient,
  "getLatestTokenProfiles" | "getLatestBoostedTokens" | "getTopBoostedTokens" | "getPairsByTokenAddresses"
>;

export type DiscoverySource = "profiles" | "boosts-latest" | "boosts-top";

export interface ScanError {
  stage: "discovery" | "pairs";
  source: string;
  kind: string;
  status: number | null;
  message: string;
}

export interface ScanStats {
  discoveredBySource: Record<DiscoverySource, number>;
  uniqueSolanaTokens: number;
  requestedTokens: number;
  pairRequests: number;
  rawPairs: number;
  keptPairs: number;
  skippedOtherChain: number;
  skippedQuoteSide: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  tokensWithoutPairs: number;
}

export interface ScanResult {
  pairs: NormalizedPair[];
  errors: ScanError[];
  stats: ScanStats;
  fetchedAt: number;
  durationMs: number;
}

export interface ScanOptions {
  /** Cap on tokens sent to /tokens/v1 (in batches of 30). */
  maxTokens?: number;
}

export async function scanSolana(client: ScanClient, options: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const maxTokens = options.maxTokens ?? 90;
  const errors: ScanError[] = [];

  // 1. Discovery
  const sources: [DiscoverySource, () => Promise<unknown>][] = [
    ["profiles", () => client.getLatestTokenProfiles()],
    ["boosts-latest", () => client.getLatestBoostedTokens()],
    ["boosts-top", () => client.getTopBoostedTokens()],
  ];
  const settled = await Promise.allSettled(sources.map(([, fn]) => fn()));

  const discoveredBySource = { profiles: 0, "boosts-latest": 0, "boosts-top": 0 } as Record<DiscoverySource, number>;
  const tokenOrder: string[] = [];
  const seenTokens = new Set<string>();

  settled.forEach((result, i) => {
    const source = sources[i][0];
    if (result.status === "rejected") {
      errors.push(toScanError("discovery", source, result.reason));
      return;
    }
    const refs = extractTokenRefs(result.value).filter((r) => r.chainId === SOLANA);
    discoveredBySource[source] = refs.length;
    for (const { tokenAddress } of refs) {
      if (seenTokens.has(tokenAddress)) continue;
      seenTokens.add(tokenAddress);
      tokenOrder.push(tokenAddress);
    }
  });

  // 2. Pairs
  const requested = tokenOrder.slice(0, maxTokens);
  const batches = chunk(requested, MAX_ADDRESSES_PER_CALL);
  const pairResults = await Promise.allSettled(
    batches.map((batch) => client.getPairsByTokenAddresses(SOLANA, batch)),
  );

  // 3. Normalise
  const requestedSet = new Set(requested);
  const byPair = new Map<string, NormalizedPair>();
  const tokensWithPairs = new Set<string>();
  let rawPairs = 0;
  let skippedOtherChain = 0;
  let skippedQuoteSide = 0;
  let skippedInvalid = 0;
  let skippedDuplicate = 0;

  pairResults.forEach((result, i) => {
    if (result.status === "rejected") {
      errors.push(toScanError("pairs", `tokens batch ${i + 1}/${batches.length} (${batches[i].length} tokens)`, result.reason));
      return;
    }
    for (const raw of extractPairs(result.value)) {
      rawPairs++;
      const pair = normalizePair(raw);
      if (!pair) {
        skippedInvalid++;
        continue;
      }
      if (pair.chainId !== SOLANA) {
        skippedOtherChain++;
        continue;
      }
      if (!requestedSet.has(pair.tokenAddress)) {
        skippedQuoteSide++;
        continue;
      }
      if (byPair.has(pair.pairAddress)) {
        skippedDuplicate++;
        continue;
      }
      byPair.set(pair.pairAddress, pair);
      tokensWithPairs.add(pair.tokenAddress);
    }
  });

  const pairs = [...byPair.values()];
  const succeededTokens = batches.filter((_, i) => pairResults[i].status === "fulfilled").flat();

  return {
    pairs,
    errors,
    stats: {
      discoveredBySource,
      uniqueSolanaTokens: tokenOrder.length,
      requestedTokens: requested.length,
      pairRequests: batches.length,
      rawPairs,
      keptPairs: pairs.length,
      skippedOtherChain,
      skippedQuoteSide,
      skippedInvalid,
      skippedDuplicate,
      tokensWithoutPairs: succeededTokens.filter((t) => !tokensWithPairs.has(t)).length,
    },
    fetchedAt: Date.now(),
    durationMs: Date.now() - started,
  };
}

/** Keeps the most liquid pair of each token. */
export function mostLiquidPairPerToken(pairs: NormalizedPair[]): NormalizedPair[] {
  const best = new Map<string, NormalizedPair>();
  for (const p of pairs) {
    const cur = best.get(p.tokenAddress);
    if (!cur || (p.liquidityUsd ?? -1) > (cur.liquidityUsd ?? -1)) best.set(p.tokenAddress, p);
  }
  return [...best.values()];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toScanError(stage: ScanError["stage"], source: string, reason: unknown): ScanError {
  if (reason instanceof DexScreenerError) {
    return { stage, source, kind: reason.kind, status: reason.status, message: `${reason.endpoint} — ${reason.message}` };
  }
  return { stage, source, kind: "unknown", status: null, message: reason instanceof Error ? reason.message : String(reason) };
}
