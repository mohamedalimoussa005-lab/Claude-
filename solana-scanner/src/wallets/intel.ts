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
import type { WalletProfile } from "./profile.ts";
import type { Trade } from "./trades.ts";
import type { LaunchTimes, PricesSol, TokenScan, WalletFacts } from "./types.ts";

export interface Buyer {
  address: string;
  firstBuy: Trade;
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
}

export interface WalletIntel {
  mint: string;
  scan: TokenScan;
  buyersIdentified: number;
  tracked: TrackedWallet[];
  independentClusters: number;
  highQuality: number;
  historiesReconstructed: number;
  highConfidence: number;
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
}

export interface IntelContext {
  creator: string | null;
  creatorFunder: string | null;
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

/** Earliest buyers first, then the largest ones not already picked. */
export function shortlist(buyers: Buyer[], n: number): Buyer[] {
  const early = [...buyers].sort((a, b) => (a.firstBuy.time ?? Infinity) - (b.firstBuy.time ?? Infinity)).slice(0, Math.ceil(n / 2));
  const picked = new Set(early.map((b) => b.address));
  const large = [...buyers].filter((b) => !picked.has(b.address)).sort((a, b) => b.solSpent - a.solSpent).slice(0, n - early.length);
  return [...early, ...large];
}

export function buildIntel(scan: TokenScan, buyers: Buyer[], facts: WalletFacts[], ctx: IntelContext, c: WalletConfig = WALLET_CONFIG): WalletIntel {
  const byAddr = new Map(facts.map((f) => [f.address, f]));
  const tracked0 = buyers.filter((b) => byAddr.has(b.address));

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
        launchTime: scan.launch?.time ?? null,
        relatedTo: group ? group.members.map((m) => m.address).filter((a) => a !== b.address) : [],
        launchTimes: ctx.launchTimes,
        pricesSol: ctx.pricesSol,
        now: ctx.now,
      },
      b.firstBuy.time,
      c,
    );
    return { ...b, profile, cluster: clusterOf.get(b.address)! };
  });
  tracked.sort((a, b) => (a.firstBuy.time ?? Infinity) - (b.firstBuy.time ?? Infinity));

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

  return {
    mint: scan.mint,
    scan,
    buyersIdentified: buyers.length,
    tracked,
    independentClusters: new Set(tracked.map((t) => t.cluster)).size,
    highQuality: tracked.filter((t) => t.profile.quality >= c.highQualityThreshold && t.profile.confidence !== "LOW").length,
    historiesReconstructed: tracked.filter((t) => t.profile.facts.trades !== null).length,
    highConfidence: tracked.filter((t) => t.profile.confidence === "HIGH").length,
    related,
    creatorBuys,
    launchSlotBuyers,
    recentEntries,
    trackedInflowSol: inflow,
    trackedInflowUsdEst: scan.solUsd !== null ? inflow * scan.solUsd : null,
    notes,
  };
}
