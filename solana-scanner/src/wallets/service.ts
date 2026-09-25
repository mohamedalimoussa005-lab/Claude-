/**
 * Pipeline: DEX candidates → on-chain validation → (this) wallet discovery on
 * the token → shortlist → per-wallet facts and bounded history. Runs only on
 * tokens that already have an on-chain result.
 */

import type { DexScreenerClient } from "../api/dexscreener.ts";
import { extractPairs, normalizePair } from "../domain/normalize.ts";
import type { NormalizedPair } from "../domain/normalize.ts";
import { classifyHolder } from "../onchain/classify.ts";
import type { OnchainResult } from "../onchain/service.ts";
import type { ScoredPair } from "../scoring/score.ts";
import { checkFunders, collectTokenScan, collectWalletFacts, HistoryBudget } from "./collect.ts";
import type { WalletRpc } from "./collect.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import { aggregateBuyers, buildIntel, shortlist } from "./intel.ts";
import type { WalletIntel } from "./intel.ts";
import { WSOL_MINT } from "./trades.ts";
import type { LaunchTimes, PricesSol, WalletFacts } from "./types.ts";

export type PriceClient = Pick<DexScreenerClient, "getPairsByTokenAddresses">;

const STABLES = new Set(["USDC", "USDT"]);

/** SOL/USD from the most liquid SOL/USDC or SOL/USDT pair on DEX Screener. */
export async function fetchSolUsd(dex: PriceClient): Promise<number | null> {
  try {
    const pairs = extractPairs(await dex.getPairsByTokenAddresses("solana", [WSOL_MINT]))
      .map(normalizePair)
      .filter((p): p is NormalizedPair => !!p && p.tokenAddress === WSOL_MINT && STABLES.has(p.quoteSymbol ?? "") && p.priceUsd !== null);
    pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    return pairs[0]?.priceUsd ?? null;
  } catch {
    return null;
  }
}

/** Current price in SOL of each mint (most liquid pair), estimate only. */
export async function fetchPricesSol(dex: PriceClient, mints: string[], solUsd: number | null): Promise<PricesSol> {
  const out: PricesSol = {};
  if (!solUsd) return out;
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const pairs = extractPairs(await dex.getPairsByTokenAddresses("solana", mints.slice(i, i + 30)))
        .map(normalizePair)
        .filter((p): p is NormalizedPair => !!p && p.priceUsd !== null);
      pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
      for (const p of pairs) if (out[p.tokenAddress] === undefined) out[p.tokenAddress] = p.priceUsd! / solUsd;
    } catch {
      /* unknown prices stay unknown */
    }
  }
  return out;
}

export class WalletIntelService {
  private readonly rpc: WalletRpc;
  private readonly dex: PriceClient;
  private readonly config: WalletConfig;
  readonly budget: HistoryBudget;
  /** Launch times of analysed tokens, shared so histories can measure early entries on them. */
  readonly launchTimes: LaunchTimes = {};
  private readonly results = new Map<string, { at: number; value: Promise<WalletIntel> }>();

  constructor(rpc: WalletRpc, dex: PriceClient, config: WalletConfig = WALLET_CONFIG) {
    this.rpc = rpc;
    this.dex = dex;
    this.config = config;
    this.budget = new HistoryBudget(config.history.maxHistoryTransactionsPerRun);
  }

  analyze(row: ScoredPair, onchain: OnchainResult, force = false): Promise<WalletIntel> {
    const key = row.pair.tokenAddress;
    const hit = this.results.get(key);
    if (hit && !force && Date.now() - hit.at < 5 * 60_000) return hit.value;
    const value = this.run(row, onchain);
    this.results.set(key, { at: Date.now(), value });
    value.catch(() => this.results.delete(key));
    return value;
  }

  private async run(row: ScoredPair, onchain: OnchainResult): Promise<WalletIntel> {
    const c = this.config;
    const mint = row.pair.tokenAddress;
    const d = onchain.data;
    const owners = d.owners.status === "ok" ? d.owners.value : {};
    const excluded = (a: string) => classifyHolder(a, owners[a], row.pair.pairAddress).excluded;
    const supply = d.mintInfo.status === "ok" ? Number(d.mintInfo.value.supplyRaw) / 10 ** d.mintInfo.value.decimals : null;
    const creator = d.creator.status === "ok" ? d.creator.value.address : null;
    const holdersPct = d.holders.status === "ok" ? d.holders.value.pctByOwner : null;

    const solUsd = await fetchSolUsd(this.dex);
    const scan = await collectTokenScan(this.rpc, mint, supply, solUsd, c);
    if (scan.launch?.time) this.launchTimes[mint] = scan.launch.time;

    const buyers = aggregateBuyers(scan, { creator, holdersPct, excluded }, c);
    const picks = shortlist(buyers, c.discovery.shortlist);

    const facts: WalletFacts[] = [];
    for (const b of picks) facts.push(await collectWalletFacts(this.rpc, b.address, this.budget, c));
    let creatorFunder: string | null = null;
    if (creator) {
      try {
        creatorFunder = (await collectWalletFacts(this.rpc, creator, new HistoryBudget(0), c)).funder;
      } catch {
        creatorFunder = null;
      }
    }
    await checkFunders(this.rpc, facts);

    const historyMints = [...new Set(facts.flatMap((f) => (f.trades ?? []).map((t) => t.mint)))];
    const pricesSol = await fetchPricesSol(this.dex, historyMints, solUsd);

    return buildIntel(scan, buyers, facts, { creator, creatorFunder, holdersPct, excluded, launchTimes: this.launchTimes, pricesSol, now: Date.now() }, c);
  }
}
