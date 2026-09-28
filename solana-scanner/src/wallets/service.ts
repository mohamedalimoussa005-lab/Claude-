/**
 * Pipeline: DEX candidates → on-chain validation → (this) wallet discovery on
 * the token → buyer shortlist + Step 3 structural wallets → per-wallet facts
 * from the history layer (WalletHistoryService, directly on the server or
 * through /api/wallet-history in the browser). Runs only on tokens that
 * already have an on-chain result.
 */

import type { DexScreenerClient } from "../api/dexscreener.ts";
import { extractPairs, normalizePair } from "../domain/normalize.ts";
import type { NormalizedPair } from "../domain/normalize.ts";
import { classifyHolder } from "../onchain/classify.ts";
import type { OnchainResult } from "../onchain/service.ts";
import type { ScoredPair } from "../scoring/score.ts";
import { checkFunders, collectTokenScan } from "./collect.ts";
import type { WalletRpc } from "./collect.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import { collectTokenWalletsFromHistory } from "./historyFacts.ts";
import type { HistorySource } from "./historyFacts.ts";
import { aggregateBuyers, buildIntel, nonBuyerEntry, shortlist, withDiagnostics } from "./intel.ts";
import type { BridgeInput, HistoryProviderDiagnostics, IntelDiagnostics, SelectionDiagnostics } from "./intel.ts";
import { compareStep3Step4, selectStructuralWallets, step3Edges } from "./structural.ts";
import type { SelectionSource } from "./structural.ts";
import { classifyFailure, RunRpcGuard } from "../history/failure.ts";
import type { WalletIntel } from "./intel.ts";
import { WSOL_MINT } from "./trades.ts";
import type { CreatorFunding } from "./profile.ts";
import type { LaunchTimes, PricesSol, TokenScan, WalletFacts } from "./types.ts";

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

export interface WalletIntelOptions {
  /**
   * The history layer, required: server-side WalletHistoryService, or the
   * browser's HttpHistorySource (backend route). Called once per token so each
   * token gets its own DEEP budget; `ctx.rpc` is the run's guarded RPC (for a
   * public-RPC history provider).
   */
  history: (ctx: { rpc: WalletRpc }) => HistorySource;
  /** Allow selective DEEP on shortlisted wallets (default false). */
  deep?: boolean;
}

export class WalletIntelService {
  private readonly rpc: WalletRpc;
  private readonly dex: PriceClient;
  private readonly config: WalletConfig;
  private readonly options: WalletIntelOptions;
  /** Launch times of analysed tokens, shared so histories can measure early entries on them. */
  readonly launchTimes: LaunchTimes = {};
  private readonly results = new Map<string, { at: number; value: Promise<WalletIntel> }>();

  constructor(rpc: WalletRpc, dex: PriceClient, config: WalletConfig = WALLET_CONFIG, options: WalletIntelOptions) {
    // Single history path: no history layer, no wallet intelligence (never a silent fallback).
    if (typeof options?.history !== "function") throw new Error("WalletIntelService needs a history layer (options.history)");
    this.rpc = rpc;
    this.dex = dex;
    this.config = config;
    this.options = options;
  }

  get deepAllowed(): boolean {
    return !!this.options.deep;
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
    // One circuit breaker per run: a spent RPC quota stops further calls to that RPC.
    const rpc = new RunRpcGuard(this.rpc);
    const stages: IntelDiagnostics["stages"] = [];
    const circuit = () => ({ state: rpc.state, skipped: rpc.skipped });
    const ictx = (creatorFunder: string | null, pricesSol: PricesSol, creatorFunding: CreatorFunding | null = null) => ({ creator, creatorFunder, creatorFunding, holdersPct, excluded, launchTimes: this.launchTimes, pricesSol, now: Date.now() });

    const solUsd = await fetchSolUsd(this.dex);
    let scan: TokenScan;
    try {
      scan = await collectTokenScan(rpc, mint, supply, solUsd, c);
    } catch (e) {
      // TOKEN-FATAL: not a single signature of the mint could be listed, so no buyer can be identified.
      const empty: TokenScan = { mint, launch: null, signaturesScanned: 0, launchReachable: false, transactionsFetched: 0, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply, solUsd };
      const intel = buildIntel(empty, [], [], ictx(null, {}), c);
      return this.withRpcProviders({ ...intel, ...withDiagnostics([], [], classifyFailure(e), circuit()), source: "history" });
    }
    if (rpc.state !== "healthy" || scan.transactionsFailed) stages.push({ stage: "token_scan", kind: rpc.openedBy ?? "unknown", wallet: null });
    if (scan.launch?.time) this.launchTimes[mint] = scan.launch.time;

    const buyers = aggregateBuyers(scan, { creator, holdersPct, excluded }, c);
    const picks = shortlist(buyers, c.discovery.shortlist);
    // Step 3 → Step 4 bridge: up to `structural.maxWallets` extra wallets from Step 3 relationship facts.
    const step3 = { data: d, related: onchain.analysis?.related ?? null };
    const structural = selectStructuralWallets(step3, { buyerPicks: picks.map((b) => b.address), isExcluded: excluded }, c);
    const buyerByAddr = new Map(buyers.map((b) => [b.address, b]));
    const analysed = [...picks.map((b) => b.address), ...structural.added.map((x) => x.address)];
    const bridge: BridgeInput = {
      buyerPicks: new Set(picks.map((b) => b.address)),
      structural: new Map([...structural.deduplicated, ...structural.added].map((x) => [x.address, { reasons: x.reasons, step3Group: x.step3Group, edges: x.edges }])),
      nonBuyers: structural.added.filter((x) => !buyerByAddr.has(x.address)).map((x) => nonBuyerEntry(scan, x.address, holdersPct)),
    };

    const fromHistory = await collectTokenWalletsFromHistory(this.options.history({ rpc }), { picks: analysed, creator, mint, supply, deepAllowed: !!this.options.deep }, c);
    const facts: WalletFacts[] = fromHistory.facts;
    const creatorFunder: string | null = fromHistory.creatorFacts?.funder ?? null;
    if (fromHistory.creatorFailure) stages.push({ stage: "creator", kind: fromHistory.creatorFailure, wallet: creator });
    // The deployment wallet's funder is checked too (once) when a wallet shares it: its activity decides the link strength.
    const funderCounts = await checkFunders(rpc, facts, (e) => stages.push({ stage: "funder_check", kind: classifyFailure(e), wallet: null }), { alsoCheck: creatorFunder });
    const cfacts = fromHistory.creatorFacts;
    const creatorFunding: CreatorFunding | null = cfacts
      ? { signature: cfacts.fundingSignature, time: cfacts.fundingTime, funderSignatureCount: creatorFunder ? (funderCounts.get(creatorFunder) ?? null) : null }
      : null;

    const historyMints = [...new Set(facts.flatMap((f) => (f.trades ?? []).map((t) => t.mint)))];
    const pricesSol = await fetchPricesSol(this.dex, historyMints, solUsd);

    const built = { ...buildIntel(scan, buyers, facts, ictx(creatorFunder, pricesSol, creatorFunding), c, bridge), ...withDiagnostics(facts, stages, null, circuit()) };
    const factsByAddr = new Map(facts.map((f) => [f.address, f]));
    const step3Comparison = compareStep3Step4(step3Edges(step3, structural), {
      links: built.related.links,
      facts: factsByAddr,
      clusterOf: new Map(built.tracked.map((t) => [t.address, t.cluster])),
    });
    const sourceOf = new Map(built.tracked.map((t) => [t.address, t.selectionSource]));
    const selection: SelectionDiagnostics = {
      buyerCandidates: buyers.length,
      buyersShortlisted: picks.length,
      structuralCandidates: structural.candidates.length,
      deduplicatedCandidates: structural.deduplicated.length,
      structuralAnalyzed: structural.added.length,
      structuralSkipped: structural.skipped.length,
      historyStepsBySelectionSource: historySteps(facts, sourceOf),
    };
    return this.withRpcProviders({ ...built, selection, step3Comparison, source: "history", creatorDistribution: fromHistory.distribution, deepRuns: fromHistory.deepRuns, historyProviders: historyProviders(facts) });
  }

  /** Server-side failover RPC (duck-typed, so this module stays free of server code): provider labels only. */
  private withRpcProviders(intel: WalletIntel): WalletIntel {
    const d = (this.rpc as { diagnostics?: () => { providers: IntelDiagnostics["rpcProviders"]; fallbacks: number } }).diagnostics?.();
    return d ? { ...intel, diagnostics: { ...intel.diagnostics, rpcProviders: d.providers, rpcFallbacks: d.fallbacks } } : intel;
  }
}

/** History provider trace steps per selection source (counts only). */
function historySteps(facts: WalletFacts[], sourceOf: Map<string, SelectionSource>): Record<SelectionSource, number> {
  const out: Record<SelectionSource, number> = { buyer: 0, structural: 0, buyer_and_structural: 0 };
  for (const f of facts) {
    const src = sourceOf.get(f.address);
    if (!src) continue;
    for (const p of f.history?.providerTrace ?? []) for (const st of p.steps) out[src] += st.count ?? 1;
  }
  return out;
}

/** PRIMARY success / failure and fallback use, from the wallets' provider traces. */
export function historyProviders(facts: WalletFacts[]): HistoryProviderDiagnostics {
  const d: HistoryProviderDiagnostics = { primarySuccess: 0, primaryFailure: 0, primaryDisabled: 0, fallbackUsed: 0, enhancedSuccess: 0, publicRpcSuccess: 0 };
  for (const f of facts) {
    for (const p of f.history?.providerTrace ?? []) {
      let primaryMissed = false;
      for (const st of p.steps) {
        const n = st.count ?? 1;
        if (st.source === "helius_primary") {
          if (st.result === "success") d.primarySuccess += n;
          else if (st.result === "disabled") (d.primaryDisabled += n), (primaryMissed = true);
          else if (st.result !== "skipped") (d.primaryFailure += n), (primaryMissed = true);
        } else if (st.result === "success") {
          if (st.source === "helius_enhanced") d.enhancedSuccess += n;
          else d.publicRpcSuccess += n;
          if (primaryMissed) d.fallbackUsed += n;
        }
      }
    }
  }
  return d;
}
