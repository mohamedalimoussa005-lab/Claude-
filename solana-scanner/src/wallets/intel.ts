/**
 * Token-level wallet intelligence from a token scan and the facts collected
 * on its shortlisted buyers. Pure. Wallets that look related count as one
 * independent cluster, never as several independent signals.
 */

import { findRelatedWallets } from "../onchain/clusters.ts";
import type { RelatedWallets } from "../onchain/clusters.ts";
import type { WalletHistory } from "../onchain/types.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import { profileWallet } from "./profile.ts";
import type { CreatorFunding, QualityUnknownReason, WalletProfile, WalletQuality } from "./profile.ts";
import type { Trade } from "./trades.ts";
import type { LaunchTimes, PricesSol, TokenScan, WalletFacts } from "./types.ts";
import type { CreatorDistribution } from "./historyFacts.ts";
import type { FailureKind } from "../history/failure.ts";
import type { SelectionSource, Step3EdgeRef, Step3Step4Comparison, StructuralReason } from "./structural.ts";

export type AnalysisStatus = "complete" | "partial" | "failed";

/** What could not be obtained, as codes (step 4.2b). Never a scoring input. */
export interface IntelDiagnostics {
  walletsAttempted: number;
  /** No failure at all. */
  walletsCompleted: number;
  /** Some facts UNKNOWN after a failure, the rest kept. */
  walletsPartial: number;
  /** Nothing requested: the provider was unavailable for this run. */
  walletsSkipped: number;
  failureKinds: Partial<Record<FailureKind, number>>;
  /** Failures outside wallet histories (token scan, creator, funder checks). */
  stages: { stage: string; kind: FailureKind; wallet: string | null }[];
  /** Set when the token itself could not be analysed. */
  tokenFatal: FailureKind | null;
  rpcCircuit: "healthy" | "unavailable_for_run";
  rpcCallsSkipped: number;
  /** Server-side RPC providers used (labels only: authenticated_rpc / public_rpc), when the RPC reports them. */
  rpcProviders?: { label: string; state: string; openedBy: FailureKind | null; ok: number; failed: number }[];
  rpcFallbacks?: number;
}

export interface Buyer {
  address: string;
  /** null for a structural wallet with no qualifying buy in the scanned transactions. */
  firstBuy: Trade | null;
  /** Minutes after the token's first transaction; null when the launch wasn't reached. */
  entryMinutesAfterLaunch: number | null;
  sameSlotAsLaunch: boolean;
  /** Entry market cap from the execution price, in SOL and USD (estimate, current SOL price). */
  entryMcapSol: number | null;
  entryMcapUsdEst: number | null;
  buys: number;
  solSpent: number;
  sells: number;
  solReceived: number;
  /** % of supply held now; null when the holder list is unavailable. */
  currentPct: number | null;
}

export interface TrackedWallet extends Buyer {
  profile: WalletProfile;
  /** Index of its independent cluster (wallets sharing an index look related). */
  cluster: number;
  /** Why the wallet was analysed: buyer shortlist, Step 3 structural bridge, or both. */
  selectionSource: SelectionSource;
  /** Structural reasons from Step 3 facts (empty for buyers only). */
  structuralReasons: StructuralReason[];
  /** Step 3 relationship group index and edges behind the structural selection. */
  structuralRefs: { step3Group: number | null; edges: Step3EdgeRef[] } | null;
}

/** Step 3 → Step 4 bridge counters. */
export interface SelectionDiagnostics {
  /** Buyers discovered in the token scan. */
  buyerCandidates: number;
  buyersShortlisted: number;
  /** Step 3 wallets eligible for the bridge. */
  structuralCandidates: number;
  /** Eligible wallets already in the buyer shortlist. */
  deduplicatedCandidates: number;
  /** Extra structural wallets analysed. */
  structuralAnalyzed: number;
  /** Eligible wallets left out by the cap. */
  structuralSkipped: number;
  /** History provider steps (trace) per selection source. */
  historyStepsBySelectionSource?: Record<SelectionSource, number>;
}

/** History provider outcomes over the analysed wallets (trace codes only). */
export interface HistoryProviderDiagnostics {
  primarySuccess: number;
  primaryFailure: number;
  /** PRIMARY not tried because turned off earlier in the process. */
  primaryDisabled: number;
  /** Phases served by another source after PRIMARY failed or was disabled. */
  fallbackUsed: number;
  enhancedSuccess: number;
  publicRpcSuccess: number;
}

export interface WalletIntel {
  mint: string;
  scan: TokenScan;
  buyersIdentified: number;
  tracked: TrackedWallet[];
  independentClusters: number;
  highQuality: number;
  historiesReconstructed: number;
  /** Wallets with a measured Wallet Quality (complete history). */
  measured: number;
  /** Wallets whose Wallet Quality is UNKNOWN; they stay in the totals and their clusters. */
  unknown: number;
  /** UNKNOWN wallets per reason code. */
  unknownByReason: Record<QualityUnknownReason["code"], number>;
  /** Legacy Confidence HIGH (capped by an applied high flag). */
  highConfidence: number;
  /**
   * Data-only counters (B1). Descriptions of the available history, never predictions of profitability:
   * highConfidenceData — Data Confidence HIGH;
   * highQualityMeasured — measured Quality ≥ threshold with Data Confidence MEDIUM or HIGH;
   * highQualityWithoutHighRiskFlags — the same set without an applied high-severity risk flag.
   */
  highConfidenceData: number;
  highQualityMeasured: number;
  highQualityWithoutHighRiskFlags: number;
  related: RelatedWallets;
  recentEntries: { address: string; time: number | null; sol: number; cluster: number | null }[];
  /** Buys by the deployment-associated wallet among the scanned transactions. */
  creatorBuys: { tokenPct: number | null; sol: number; count: number; inLaunchSlot: boolean } | null;
  /** Distinct non-creator wallets that bought in the same block as the token's first transaction. */
  launchSlotBuyers: number;
  /** SOL spent by tracked wallets in the scanned transactions. */
  trackedInflowSol: number;
  trackedInflowUsdEst: number | null;
  notes: string[];
  analysisStatus: AnalysisStatus;
  diagnostics: IntelDiagnostics;
  /** Always the history layer (the only wallet history path). */
  source?: "history";
  /** Creator token transfers to other wallets (not sells), when the creator's history was read. */
  creatorDistribution?: CreatorDistribution | null;
  deepRuns?: number;
  /** Step 3 → Step 4 bridge. */
  selection?: SelectionDiagnostics;
  /** Step 3 relationship evidence vs Step 4 observations, for wallets Step 4 analysed. Descriptive only. */
  step3Comparison?: Step3Step4Comparison[];
  historyProviders?: HistoryProviderDiagnostics;
}

/** Extra wallets from the Step 3 bridge (`buyerPicks` = the buyer shortlist). */
export interface BridgeInput {
  buyerPicks: Set<string>;
  /** Structural wallets (analysed or deduplicated) by address. */
  structural: Map<string, { reasons: StructuralReason[]; step3Group: number | null; edges: Step3EdgeRef[] }>;
  /** Structural wallets that are not scan buyers (no qualifying buy). */
  nonBuyers: Buyer[];
}

export interface IntelContext {
  creator: string | null;
  creatorFunder: string | null;
  creatorFunding?: CreatorFunding | null;
  holdersPct: Record<string, number> | null;
  excluded: (address: string) => boolean;
  launchTimes: LaunchTimes;
  pricesSol: PricesSol;
  now: number;
}

export function aggregateBuyers(scan: TokenScan, ctx: Pick<IntelContext, "creator" | "holdersPct" | "excluded">, c: WalletConfig = WALLET_CONFIG): Buyer[] {
  const seen = new Set<string>();
  const trades = [...scan.earlyTrades, ...scan.recentTrades].filter((t) => (seen.has(t.signature + t.owner) ? false : (seen.add(t.signature + t.owner), true)));
  const byOwner = new Map<string, Trade[]>();
  for (const t of trades) byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t]);
  const buyers: Buyer[] = [];
  for (const [address, ts] of byOwner) {
    if (address === ctx.creator || ctx.excluded(address)) continue;
    const buys = ts.filter((t) => t.side === "buy" && t.sol >= c.discovery.minBuySol).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    if (!buys.length) continue;
    const sells = ts.filter((t) => t.side === "sell");
    const first = buys[0];
    const price = first.tokenAmount > 0 ? first.sol / first.tokenAmount : null;
    const mcapSol = price !== null && scan.supply !== null ? price * scan.supply : null;
    buyers.push({
      address,
      firstBuy: first,
      entryMinutesAfterLaunch: scan.launch?.time && first.time ? Math.max(0, (first.time - scan.launch.time) / 60_000) : null,
      sameSlotAsLaunch: scan.launch?.slot != null && first.slot === scan.launch.slot,
      entryMcapSol: mcapSol,
      entryMcapUsdEst: mcapSol !== null && scan.solUsd !== null ? mcapSol * scan.solUsd : null,
      buys: buys.length,
      solSpent: buys.reduce((s, t) => s + t.sol, 0),
      sells: sells.length,
      solReceived: sells.reduce((s, t) => s + t.sol, 0),
      currentPct: ctx.holdersPct ? (ctx.holdersPct[address] ?? 0) : null,
    });
  }
  return buyers;
}

/** A structural wallet with no qualifying buy in the scan: its scanned sells only, no entry. */
export function nonBuyerEntry(scan: TokenScan, address: string, holdersPct: Record<string, number> | null): Buyer {
  const sells = [...scan.earlyTrades, ...scan.recentTrades].filter((t, i, all) => t.owner === address && t.side === "sell" && all.findIndex((x) => x.signature === t.signature && x.owner === t.owner) === i);
  return {
    address,
    firstBuy: null,
    entryMinutesAfterLaunch: null,
    sameSlotAsLaunch: false,
    entryMcapSol: null,
    entryMcapUsdEst: null,
    buys: 0,
    solSpent: 0,
    sells: sells.length,
    solReceived: sells.reduce((s, t) => s + t.sol, 0),
    currentPct: holdersPct ? (holdersPct[address] ?? 0) : null,
  };
}

/** Earliest buyers first, then the largest ones not already picked. */
export function shortlist(buyers: Buyer[], n: number): Buyer[] {
  const early = [...buyers].sort((a, b) => (a.firstBuy?.time ?? Infinity) - (b.firstBuy?.time ?? Infinity)).slice(0, Math.ceil(n / 2));
  const picked = new Set(early.map((b) => b.address));
  const large = [...buyers].filter((b) => !picked.has(b.address)).sort((a, b) => b.solSpent - a.solSpent).slice(0, n - early.length);
  return [...early, ...large];
}

export function buildIntel(scan: TokenScan, buyers: Buyer[], facts: WalletFacts[], ctx: IntelContext, c: WalletConfig = WALLET_CONFIG, bridge: BridgeInput | null = null): WalletIntel {
  const byAddr = new Map(facts.map((f) => [f.address, f]));
  const buyerAddrs = new Set(buyers.map((b) => b.address));
  // Structural wallets join the same analysis: related-wallet detection, clusters, flags, Quality.
  const tracked0 = [...buyers, ...(bridge?.nonBuyers ?? []).filter((b) => !buyerAddrs.has(b.address))].filter((b) => byAddr.has(b.address));
  const selection = (a: string): Pick<TrackedWallet, "selectionSource" | "structuralReasons" | "structuralRefs"> => {
    const st = bridge?.structural.get(a);
    const buyer = bridge ? bridge.buyerPicks.has(a) : true;
    return {
      selectionSource: st ? (buyer ? "buyer_and_structural" : "structural") : "buyer",
      structuralReasons: st ? [...st.reasons] : [],
      structuralRefs: st ? { step3Group: st.step3Group, edges: st.edges } : null,
    };
  };

  const histories: WalletHistory[] = tracked0.map((b) => {
    const f = byAddr.get(b.address)!;
    return {
      address: b.address,
      pct: b.currentPct ?? 0,
      signatureCount: f.signatureCount,
      historyComplete: f.historyComplete,
      firstSeen: f.firstSeen,
      funder: f.funder,
      fundingSignature: f.fundingSignature,
      funderSignatureCount: f.funderSignatureCount,
      signatures: f.signatures,
    };
  });
  const related = findRelatedWallets(histories, { closeCreationMinutes: 10, busyFunderSignatures: 1000 });

  // Independent clusters: each related group counts once, every other wallet alone.
  const clusterOf = new Map<string, number>();
  related.groups.forEach((g, i) => g.members.forEach((m) => clusterOf.set(m.address, i + 1)));
  let next = related.groups.length + 1;
  for (const b of tracked0) if (!clusterOf.has(b.address)) clusterOf.set(b.address, next++);

  const tracked: TrackedWallet[] = tracked0.map((b) => {
    const group = related.groups.find((g) => g.members.some((m) => m.address === b.address));
    const profile = profileWallet(
      byAddr.get(b.address)!,
      {
        creator: ctx.creator,
        creatorFunder: ctx.creatorFunder,
        creatorFunding: ctx.creatorFunding ?? null,
        launchTime: scan.launch?.time ?? null,
        relatedTo: group ? group.members.map((m) => m.address).filter((a) => a !== b.address) : [],
        relatedLinks: group
          ? related.links
              .filter((l) => (l.a === b.address || l.b === b.address) && (l.strength === "strong" || l.strength === "medium"))
              .map((l) => ({ type: l.type, strength: l.strength, key: l.key, other: l.a === b.address ? l.b : l.a }))
              .filter((l) => group.members.some((m) => m.address === l.other))
          : [],
        launchTimes: ctx.launchTimes,
        pricesSol: ctx.pricesSol,
        now: ctx.now,
      },
      b.firstBuy?.time ?? null,
      c,
    );
    return { ...b, profile, cluster: clusterOf.get(b.address)!, ...selection(b.address) };
  });
  tracked.sort((a, b) => (a.firstBuy?.time ?? Infinity) - (b.firstBuy?.time ?? Infinity));

  const recentSeen = new Set<string>();
  const recentEntries = scan.recentTrades
    .filter((t) => t.side === "buy" && t.sol >= c.discovery.minBuySol && t.owner !== ctx.creator && !ctx.excluded(t.owner))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .filter((t) => (recentSeen.has(t.owner) ? false : (recentSeen.add(t.owner), true)))
    .slice(0, 10)
    .map((t) => ({ address: t.owner, time: t.time, sol: t.sol, cluster: clusterOf.get(t.owner) ?? null }));

  const inflow = tracked.reduce((s, t) => s + t.solSpent, 0);
  const creatorTrades = ctx.creator ? scan.earlyTrades.filter((t) => t.owner === ctx.creator && t.side === "buy") : [];
  const creatorBuys = creatorTrades.length
    ? {
        tokenPct: scan.supply ? (creatorTrades.reduce((s, t) => s + t.tokenAmount, 0) / scan.supply) * 100 : null,
        sol: creatorTrades.reduce((s, t) => s + t.sol, 0),
        count: creatorTrades.length,
        inLaunchSlot: scan.launch?.slot != null && creatorTrades.some((t) => t.slot === scan.launch!.slot),
      }
    : null;
  const launchSlotBuyers =
    scan.launch?.slot != null
      ? new Set(scan.earlyTrades.filter((t) => t.side === "buy" && t.slot === scan.launch!.slot && t.owner !== ctx.creator).map((t) => t.owner)).size
      : 0;
  const notes: string[] = [];
  if (!scan.launchReachable) notes.push(`Première transaction du token hors de portée (${scan.signaturesScanned.toLocaleString("en-US")} signatures parcourues) : premiers acheteurs et délais d'entrée UNKNOWN, seuls les acheteurs récents sont identifiés.`);
  if (scan.transactionsFailed) notes.push(`${scan.transactionsFailed} transaction(s) non récupérée(s) (RPC).`);
  if (scan.undecodable) notes.push(`${scan.undecodable} mouvement(s) non décodable(s) comme achat/vente (transferts, routes multi-tokens, quote non SOL) : ignorés, pas devinés.`);
  notes.push(`Échantillon : ${scan.earlyTrades.length + scan.recentTrades.length} trades décodés sur ${scan.transactionsFetched} transactions ; montants en SOL vérifiables, USD estimé au prix SOL actuel.`);

  const hqMeasured = tracked.filter(
    (t) => t.profile.quality.status === "measured" && t.profile.quality.value >= c.highQualityThreshold && (t.profile.dataConfidence === "MEDIUM" || t.profile.dataConfidence === "HIGH"),
  );
  return {
    mint: scan.mint,
    scan,
    buyersIdentified: buyers.length,
    tracked,
    independentClusters: new Set(tracked.map((t) => t.cluster)).size,
    highQuality: tracked.filter((t) => t.profile.quality.status === "measured" && t.profile.quality.value >= c.highQualityThreshold && t.profile.confidence !== "LOW").length,
    historiesReconstructed: tracked.filter((t) => t.profile.facts.trades !== null).length,
    measured: tracked.filter((t) => t.profile.quality.status === "measured").length,
    unknown: tracked.filter((t) => t.profile.quality.status === "unknown").length,
    unknownByReason: countUnknownByReason(tracked.map((t) => t.profile.quality)),
    highConfidence: tracked.filter((t) => t.profile.confidence === "HIGH").length,
    highConfidenceData: tracked.filter((t) => t.profile.dataConfidence === "HIGH").length,
    highQualityMeasured: hqMeasured.length,
    highQualityWithoutHighRiskFlags: hqMeasured.filter((t) => t.profile.risk.maxApplied !== "high").length,
    related,
    creatorBuys,
    launchSlotBuyers,
    recentEntries,
    trackedInflowSol: inflow,
    trackedInflowUsdEst: scan.solUsd !== null ? inflow * scan.solUsd : null,
    notes,
    ...withDiagnostics(facts, [], null),
  };
}

/** Token status and diagnostics from the wallets' recorded failures plus token-level stages. */
export function withDiagnostics(
  facts: WalletFacts[],
  stages: IntelDiagnostics["stages"],
  tokenFatal: FailureKind | null,
  circuit: { state: IntelDiagnostics["rpcCircuit"]; skipped: number } = { state: "healthy", skipped: 0 },
): { analysisStatus: AnalysisStatus; diagnostics: IntelDiagnostics } {
  const failureKinds: Partial<Record<FailureKind, number>> = {};
  const count = (k: FailureKind) => (failureKinds[k] = (failureKinds[k] ?? 0) + 1);
  for (const f of facts) for (const st of f.failure?.stages ?? []) count(st.kind);
  for (const st of stages) count(st.kind);
  if (tokenFatal) count(tokenFatal);
  const skipped = facts.filter((f) => f.failure?.skipped).length;
  const partial = facts.filter((f) => f.failure && !f.failure.skipped).length;
  const diagnostics: IntelDiagnostics = {
    walletsAttempted: facts.length,
    walletsCompleted: facts.length - skipped - partial,
    walletsPartial: partial,
    walletsSkipped: skipped,
    failureKinds,
    stages,
    tokenFatal,
    rpcCircuit: circuit.state,
    rpcCallsSkipped: circuit.skipped,
  };
  const analysisStatus: AnalysisStatus = tokenFatal ? "failed" : Object.keys(failureKinds).length ? "partial" : "complete";
  return { analysisStatus, diagnostics };
}

export function countUnknownByReason(qs: WalletQuality[]): Record<QualityUnknownReason["code"], number> {
  const out: Record<QualityUnknownReason["code"], number> = { history_incomplete: 0, no_evaluable_position: 0, provider_failure: 0, skipped: 0 };
  for (const q of qs) if (q.status === "unknown") out[q.reason.code]++;
  return out;
}
