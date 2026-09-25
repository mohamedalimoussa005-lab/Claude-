/**
 * Wallet profile from collected facts: positions, performance metrics (only
 * from a COMPLETE history), suspicious patterns, Wallet Quality and Confidence.
 * Pure and deterministic.
 */

import { interpolate } from "../scoring/curve.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import type { Trade } from "./trades.ts";
import type { LaunchTimes, PricesSol, WalletFacts } from "./types.ts";

export type WalletConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface Position {
  mint: string;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  tokensIn: number;
  tokensOut: number;
  firstBuy: number | null;
  lastSell: number | null;
  /** Realised return on the sold part (SOL basis). null when nothing sold. */
  realizedReturn: number | null;
  /** Estimated value of what is still held, from the current DEX Screener price. null when unknown. */
  heldValueSolEst: number | null;
  /** Total return (realised + estimated unrealised). null when the held part can't be valued. */
  totalReturnEst: number | null;
  /** Entry within 1 h of launch; null when the launch time is unknown. */
  entryMinutesAfterLaunch: number | null;
  holdMinutes: number | null;
}

export interface WalletMetrics {
  positions: Position[];
  /** Positions with a computable return. */
  evaluated: number;
  profitable: number;
  losing: number;
  medianReturn: number | null;
  averageReturn: number | null;
  best: Position | null;
  worst: Position | null;
  early: { known: number; lt5m: number; lt15m: number; lt1h: number };
  medianHoldMinutes: number | null;
  realizedPnlSol: number;
  unrealizedPnlSolEst: number | null;
}

export interface WalletFlag {
  key: string;
  label: string;
  severity: "high" | "medium" | "low";
  detail: string;
}

export interface QualityItem {
  label: string;
  detail: string;
  points: number;
  max: number;
}

export interface WalletProfile {
  address: string;
  facts: WalletFacts;
  metrics: WalletMetrics | null;
  flags: WalletFlag[];
  quality: number;
  qualityItems: QualityItem[];
  confidence: WalletConfidence;
  /** Things that could not be measured. */
  unknowns: string[];
}

export interface ProfileContext {
  /** Deployment-associated wallet of the token being analysed. */
  creator: string | null;
  /** Funder of the deployment-associated wallet, when known. */
  creatorFunder: string | null;
  launchTime: number | null;
  /** Other wallets in the same potentially-related group. */
  relatedTo: string[];
  launchTimes: LaunchTimes;
  pricesSol: PricesSol;
  now: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function buildPositions(trades: Trade[], launchTimes: LaunchTimes, pricesSol: PricesSol): Position[] {
  const byMint = new Map<string, Trade[]>();
  for (const t of trades) byMint.set(t.mint, [...(byMint.get(t.mint) ?? []), t]);
  const out: Position[] = [];
  for (const [mint, ts] of byMint) {
    ts.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    const buys = ts.filter((t) => t.side === "buy");
    const sells = ts.filter((t) => t.side === "sell");
    if (!buys.length) continue; // sold tokens that were never bought here (received): not a position we can value
    const solIn = buys.reduce((s, t) => s + t.sol, 0);
    const solOut = sells.reduce((s, t) => s + t.sol, 0);
    const tokensIn = buys.reduce((s, t) => s + t.tokenAmount, 0);
    const tokensOut = Math.min(tokensIn, sells.reduce((s, t) => s + t.tokenAmount, 0));
    const soldShare = tokensIn > 0 ? tokensOut / tokensIn : 0;
    const costOfSold = solIn * soldShare;
    const realizedReturn = tokensOut > 0 && costOfSold > 0 ? solOut / costOfSold - 1 : null;
    const held = tokensIn - tokensOut;
    const price = pricesSol[mint];
    const heldValueSolEst = held <= tokensIn * 0.001 ? 0 : price !== undefined ? held * price : null;
    const totalReturnEst = heldValueSolEst === null || solIn <= 0 ? null : (solOut + heldValueSolEst) / solIn - 1;
    const firstBuy = buys[0].time;
    const lastSell = sells.length ? sells[sells.length - 1].time : null;
    const launch = launchTimes[mint];
    out.push({
      mint,
      buys: buys.length,
      sells: sells.length,
      solIn,
      solOut,
      tokensIn,
      tokensOut,
      firstBuy,
      lastSell,
      realizedReturn,
      heldValueSolEst,
      totalReturnEst,
      entryMinutesAfterLaunch: launch !== undefined && firstBuy !== null ? Math.max(0, (firstBuy - launch) / 60_000) : null,
      holdMinutes: firstBuy !== null && lastSell !== null && soldShare > 0.99 ? (lastSell - firstBuy) / 60_000 : null,
    });
  }
  return out;
}

export function computeMetrics(positions: Position[]): WalletMetrics {
  const evaluated = positions.filter((p) => p.totalReturnEst !== null);
  const returns = evaluated.map((p) => p.totalReturnEst!);
  const byReturn = [...evaluated].sort((a, b) => a.totalReturnEst! - b.totalReturnEst!);
  const known = positions.filter((p) => p.entryMinutesAfterLaunch !== null).map((p) => p.entryMinutesAfterLaunch!);
  const holds = positions.map((p) => p.holdMinutes).filter((h): h is number => h !== null);
  const realizedPnlSol = positions.reduce((s, p) => s + (p.tokensOut > 0 ? p.solOut - p.solIn * (p.tokensOut / p.tokensIn) : 0), 0);
  const unrealizedParts = positions.map((p) => (p.heldValueSolEst === null ? null : p.heldValueSolEst - p.solIn * (1 - p.tokensOut / p.tokensIn)));
  return {
    positions,
    evaluated: evaluated.length,
    profitable: returns.filter((r) => r > 0).length,
    losing: returns.filter((r) => r <= 0).length,
    medianReturn: median(returns),
    averageReturn: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
    best: byReturn[byReturn.length - 1] ?? null,
    worst: byReturn[0] ?? null,
    early: { known: known.length, lt5m: known.filter((m) => m < 5).length, lt15m: known.filter((m) => m < 15).length, lt1h: known.filter((m) => m < 60).length },
    medianHoldMinutes: median(holds),
    realizedPnlSol,
    unrealizedPnlSolEst: unrealizedParts.some((u) => u === null) ? null : unrealizedParts.reduce((a: number, b) => a + (b ?? 0), 0),
  };
}

export function detectFlags(f: WalletFacts, ctx: ProfileContext, entryTime: number | null, c: WalletConfig = WALLET_CONFIG): WalletFlag[] {
  const flags: WalletFlag[] = [];
  const add = (key: string, label: string, severity: WalletFlag["severity"], detail: string) => flags.push({ key, label, severity, detail });

  if (ctx.creator && f.address === ctx.creator) add("creator", "Deployment-associated wallet", "high", "adresse liée au déploiement du token");
  if (ctx.creator && f.funder === ctx.creator) add("fundedByCreator", "Financé par le deployment-associated wallet", "high", `financé par ${short(ctx.creator)}`);
  if (ctx.creatorFunder && f.funder === ctx.creatorFunder) add("sameFunderAsCreator", "Même financeur que le deployment-associated wallet", "high", `financeur commun ${short(ctx.creatorFunder)}`);
  if (f.signatureCount >= c.flags.busySignatures) {
    add("busy", "Activité de type bot / haute fréquence", "medium", `≥ ${c.flags.busySignatures.toLocaleString("en-US")} transactions`);
  }
  if (f.firstSeen !== null && entryTime !== null && entryTime - f.firstSeen < c.flags.freshWalletHours * 3_600_000) {
    add("fresh", "Wallet créé très récemment", "medium", `première activité ${((entryTime - f.firstSeen) / 3_600_000).toFixed(1)} h avant son entrée`);
  }
  if (f.fundingTime !== null && ctx.launchTime !== null && ctx.launchTime - f.fundingTime >= 0 && ctx.launchTime - f.fundingTime < c.flags.fundedBeforeLaunchMinutes * 60_000) {
    add("fundedBeforeLaunch", "Financé juste avant le lancement", "high", `${((ctx.launchTime - f.fundingTime) / 60_000).toFixed(1)} min avant la création du token`);
  }
  if (ctx.relatedTo.length) add("related", "Potentiellement lié à d'autres acheteurs", "medium", ctx.relatedTo.map(short).join(", "));
  if (f.trades && f.trades.length >= 10) {
    const avg = f.trades.reduce((s, t) => s + t.sol, 0) / f.trades.length;
    if (avg < c.flags.microTicketSol) add("micro", "Micro-transactions", "medium", `ticket moyen ${avg.toFixed(4)} SOL`);
    const tokens = new Set(f.trades.filter((t) => t.side === "buy").map((t) => t.mint)).size;
    if ((tokens / Math.max(1, f.signatureCount)) * 100 >= c.flags.tokensPer100Txs && tokens >= 10) {
      add("buysEverything", "Achète presque tous les nouveaux tokens", "low", `${tokens} tokens différents sur ${f.signatureCount} transactions`);
    }
  }
  if (!f.trades) add("incomplete", "Historique trop incomplet", "low", f.historyNote);
  return flags;
}

export function profileWallet(f: WalletFacts, ctx: ProfileContext, entryTime: number | null, c: WalletConfig = WALLET_CONFIG): WalletProfile {
  const q = c.quality;
  const flags = detectFlags(f, ctx, entryTime, c);
  const unknowns: string[] = [];
  const items: QualityItem[] = [];
  let metrics: WalletMetrics | null = null;

  if (f.trades) {
    metrics = computeMetrics(buildPositions(f.trades, ctx.launchTimes, ctx.pricesSol));
    const n = metrics.evaluated;
    items.push({ label: "Taille de l'échantillon", detail: `${n} position(s) évaluable(s)`, points: interpolate(q.sampleSize.curve, n), max: q.sampleSize.max });
    const winRate = n ? metrics.profitable / n : 0;
    const weight = Math.min(1, n / q.consistency.fullAtTrades);
    items.push({ label: "Régularité", detail: n ? `${metrics.profitable}/${n} rentables, poids ${(weight * 100).toFixed(0)} %` : "aucune position", points: interpolate(q.consistency.curve, winRate) * weight, max: q.consistency.max });
    const earlyRate = metrics.early.known ? metrics.early.lt1h / metrics.early.known : null;
    items.push({ label: "Entrées précoces", detail: earlyRate === null ? "lancement inconnu pour ses tokens" : `${metrics.early.lt1h}/${metrics.early.known} < 1 h`, points: earlyRate === null ? 0 : interpolate(q.earlyEntry.curve, earlyRate) * weight, max: q.earlyEntry.max });
    if (earlyRate === null) unknowns.push("Heure de lancement inconnue pour les tokens de son historique : taux d'entrée précoce non mesuré.");
    items.push({ label: "Performance réalisée (médiane, estimée)", detail: metrics.medianReturn === null ? "non calculable" : `${(metrics.medianReturn * 100).toFixed(0)} %`, points: metrics.medianReturn === null ? 0 : interpolate(q.realized.curve, metrics.medianReturn) * weight, max: q.realized.max });
    items.push({ label: "Pire position (estimée)", detail: metrics.worst ? `${(metrics.worst.totalReturnEst! * 100).toFixed(0)} %` : "non calculable", points: metrics.worst ? interpolate(q.riskAdjusted.curve, metrics.worst.totalReturnEst!) * weight : 0, max: q.riskAdjusted.max });
    items.push({ label: "Complétude des données", detail: "historique complet reconstruit", points: q.completeness.max, max: q.completeness.max });
    if (metrics.positions.some((p) => p.heldValueSolEst === null)) unknowns.push("Prix actuel inconnu pour certains tokens encore détenus : leur rendement n'est pas estimé.");
    unknowns.push("Multiple maximum après l'entrée : non calculable sans historique de prix (OHLCV) — le RPC ne fournit pas de prix.");
  } else {
    items.push({ label: "Historique", detail: f.historyNote, points: 0, max: q.sampleSize.max + q.consistency.max + q.earlyEntry.max + q.realized.max + q.riskAdjusted.max + q.completeness.max });
    unknowns.push(`Historique non reconstruit : ${f.historyNote}. Trades, PnL, rendements, entrées précoces et durée de détention : UNKNOWN.`);
  }

  const penalty = flags.reduce((s, fl) => s + q.penalties[fl.severity], 0);
  if (penalty) items.push({ label: "Pénalités (motifs suspects)", detail: flags.map((fl) => fl.label).join(", "), points: -penalty, max: 0 });
  for (const it of items) it.points = r1(it.points);
  const quality = Math.max(0, Math.min(100, Math.round(items.reduce((s, it) => s + it.points, 0))));

  const n = metrics?.evaluated ?? 0;
  let confidence: WalletConfidence = f.trades && n >= c.confidence.highMinPositions ? "HIGH" : f.trades && n >= c.confidence.mediumMinPositions ? "MEDIUM" : "LOW";
  if (flags.some((fl) => fl.severity === "high") && confidence === "HIGH") confidence = "MEDIUM";

  return { address: f.address, facts: f, metrics, flags, quality, qualityItems: items, confidence, unknowns };
}
