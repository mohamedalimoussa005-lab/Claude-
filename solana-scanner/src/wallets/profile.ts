/**
 * Wallet profile from collected facts: positions, performance metrics (only
 * from a COMPLETE history), suspicious patterns, Wallet Quality and Confidence.
 * Pure and deterministic.
 */

import type { FailureKind } from "../history/failure.ts";
import type { LinkStrength, LinkType } from "../onchain/clusters.ts";
import { ONCHAIN_CONFIG } from "../onchain/config.ts";
import { interpolate } from "../scoring/curve.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import type { Trade } from "./trades.ts";
import type { LaunchTimes, PricesSol, WalletFacts } from "./types.ts";

/** Legacy Confidence: data volume, capped HIGH → MEDIUM by an applied high-severity flag (kept for compatibility). */
export type WalletConfidence = "LOW" | "MEDIUM" | "HIGH";
/**
 * Data Confidence: how much measured data stands behind Wallet Quality, nothing else.
 * UNKNOWN when Quality is UNKNOWN; otherwise from evaluable positions only. No flag caps it.
 */
export type DataConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

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
  /** SOL received minus the cost of the sold part (SOL, fees included). null when nothing sold. */
  realizedPnlSol: number | null;
  /** Everything bought was sold (≥ 99 %). */
  closed: boolean;
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

/**
 * Phenomenon a penalty describes; within one, the same evidence is penalised once.
 * "data" is a data status (incomplete history), never a suspicious pattern and never a penalty.
 */
export type FlagGroup = "funding_event" | "automation" | "funding_link" | "data";

/** Reliable facts about why a history is incomplete (from the history layer's own records only). */
export type IncompleteDetail = "history_too_long" | "completion_budget" | "deep_disabled" | "deep_incomplete";

/** Why Wallet Quality could not be computed. */
export type QualityUnknownReason =
  | { code: "history_incomplete"; details: IncompleteDetail[] }
  | { code: "provider_failure"; kind: FailureKind }
  | { code: "skipped"; kind: FailureKind };

/**
 * Wallet Quality: a number only when the history is complete (facts.trades
 * !== null); otherwise UNKNOWN with its reason — never 0 by default.
 */
export type WalletQuality = { status: "measured"; value: number } | { status: "unknown"; reason: QualityUnknownReason };

export interface WalletFlag {
  key: string;
  label: string;
  severity: "high" | "medium" | "low";
  detail: string;
  group: FlagGroup | null;
  /** Provenance of the evidence behind the flag (ids local to this wallet); empty = not traceable. */
  evidence: string[];
  /** false when the same evidence is already penalised by a stronger flag of the same phenomenon (duplicate). */
  penaltyApplied: boolean;
  /** Key of the flag whose penalty already covers this evidence. */
  suppressedBy: string | null;
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
  quality: WalletQuality;
  qualityItems: QualityItem[];
  /** Legacy indicator (data volume capped by an applied high flag); see dataConfidence and risk. */
  confidence: WalletConfidence;
  dataConfidence: DataConfidence;
  /** Risk observations derived from the flags (no new signal). */
  risk: RiskSummary;
  /** Things that could not be measured. */
  unknowns: string[];
  /** Observed relationship with the deployment-associated wallet (null = none observed). Never a cluster link. */
  creatorLink: CreatorLink | null;
}

/** Funding of the deployment-associated wallet, from its history. */
export interface CreatorFunding {
  signature: string | null;
  time: number | null;
  /** Signatures of its funder (one page); null = activity not checked (UNKNOWN). */
  funderSignatureCount: number | null;
}

/**
 * Wallet ↔ deployment-associated wallet, with the relationship engine's
 * taxonomy (onchain/clusters.ts) and its constants:
 *   strong  — funded by it; same funding transaction; same funder counted as
 *             NOT busy and funded within the close-creation window
 *   medium  — same funder counted as not busy, at different times
 *   weak    — same busy funder (exchange / service): descriptive only
 *   unknown — same funder whose activity was not counted: never presumed rare
 */
export type CreatorLinkType = "fundedByCreator" | "sameFundingTx" | "sameFunderClose" | "sameFunder" | "sameBusyFunder" | "sameFunderUnknownActivity";
export interface CreatorLink {
  type: CreatorLinkType;
  strength: "strong" | "medium" | "weak" | "unknown";
  /** Funder (or the deployment wallet itself for fundedByCreator). */
  key: string;
  detail: string;
}

export interface ProfileContext {
  /** Deployment-associated wallet of the token being analysed. */
  creator: string | null;
  /** Funder of the deployment-associated wallet, when known. */
  creatorFunder: string | null;
  /** Its funding transaction, time and funder activity; missing = UNKNOWN. */
  creatorFunding?: CreatorFunding | null;
  launchTime: number | null;
  /** Other wallets in the same potentially-related group. */
  relatedTo: string[];
  /** This wallet's own strong / medium links inside its group (provenance of `related`); missing = not traceable. */
  relatedLinks?: { type: LinkType; strength: LinkStrength; key: string | null; other: string }[];
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
      realizedPnlSol: tokensOut > 0 ? solOut - costOfSold : null,
      closed: soldShare > 0.99,
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

export function classifyCreatorLink(f: WalletFacts, ctx: ProfileContext): CreatorLink | null {
  if (!ctx.creator || f.address === ctx.creator) return null;
  if (f.funder === ctx.creator) return { type: "fundedByCreator", strength: "strong", key: ctx.creator, detail: `financé par ${short(ctx.creator)}` };
  const cf = ctx.creatorFunding ?? null;
  if (cf?.signature && f.fundingSignature === cf.signature) {
    return { type: "sameFundingTx", strength: "strong", key: f.funder ?? ctx.creator, detail: "financé dans la même transaction que le deployment-associated wallet" };
  }
  if (!ctx.creatorFunder || f.funder !== ctx.creatorFunder) return null;
  const funder = ctx.creatorFunder;
  // Same funder address: either count describes it. null = never counted = UNKNOWN (never presumed rare).
  const count = cf?.funderSignatureCount ?? f.funderSignatureCount ?? null;
  const { busyFunderSignatures, closeCreationMinutes } = ONCHAIN_CONFIG.clusters;
  if (count === null) {
    return { type: "sameFunderUnknownActivity", strength: "unknown", key: funder, detail: `financeur commun ${short(funder)} avec le deployment-associated wallet ; activité du financeur inconnue : preuve insuffisante` };
  }
  if (count >= busyFunderSignatures) {
    return { type: "sameBusyFunder", strength: "weak", key: funder, detail: `financeur commun ${short(funder)}, adresse très active (probablement un exchange ou un service) : relation faible` };
  }
  const gap = f.fundingTime !== null && cf?.time != null ? Math.abs(f.fundingTime - cf.time) : null;
  if (gap !== null && gap <= closeCreationMinutes * 60_000) {
    return { type: "sameFunderClose", strength: "strong", key: funder, detail: `financeur commun ${short(funder)} (peu actif), financements à ${(gap / 60_000).toFixed(1)} min d'écart` };
  }
  return { type: "sameFunder", strength: "medium", key: funder, detail: `financeur commun ${short(funder)} (peu actif), à des moments différents` };
}

export function detectFlags(f: WalletFacts, ctx: ProfileContext, entryTime: number | null, c: WalletConfig = WALLET_CONFIG, link: CreatorLink | null = classifyCreatorLink(f, ctx)): WalletFlag[] {
  const flags: WalletFlag[] = [];
  const add = (key: string, label: string, severity: WalletFlag["severity"], detail: string, group: FlagGroup | null = null, evidence: string[] = []) =>
    flags.push({ key, label, severity, detail, group, evidence, penaltyApplied: true, suppressedBy: null });
  // The wallet's own funding (first transaction): what creator links and funder-based relations are built on.
  const ownFunding = "funding:self";

  if (ctx.creator && f.address === ctx.creator) add("creator", "Deployment-associated wallet", "high", "adresse liée au déploiement du token");
  // Strength of the observed link → existing severities; weak / unknown links are descriptive only (no flag).
  if (link?.type === "fundedByCreator") add("fundedByCreator", "Financé par le deployment-associated wallet", "high", link.detail, "funding_link", [ownFunding]);
  else if (link?.strength === "strong") add("sameFunderAsCreator", "Même financement que le deployment-associated wallet", "high", link.detail, "funding_link", [ownFunding]);
  else if (link?.strength === "medium") add("sameFunderAsCreator", "Même financeur (peu actif) que le deployment-associated wallet", "medium", link.detail, "funding_link", [ownFunding]);
  // Same flag, same severity as before; step 4.2 adds behavioural evidence from normalized transactions.
  const bot = f.history?.bot;
  if (f.signatureCount >= c.flags.busySignatures || bot?.botLike) {
    const count = f.signatureCount >= c.flags.busySignatures ? `≥ ${c.flags.busySignatures.toLocaleString("en-US")} transactions` : null;
    // Token breadth is part of this flag only when it made the wallet bot-like, on transactions of a complete history
    // (the recent sample is then part of the trades the other token-breadth flag reads).
    const evidence = [
      ...(count ? ["signatureCount"] : []),
      ...(bot?.botLike ? ["bot:frequency", ...(bot.fastFlipper ? ["bot:fastFlips"] : []), ...(bot.manyTokens && f.trades ? ["tokenBreadth"] : [])] : []),
    ];
    add("busy", "Activité de type bot / haute fréquence", "medium", [count, ...(bot?.botLike ? bot.evidence : [])].filter(Boolean).join(" ; "), "automation", evidence);
  }
  if (f.firstSeen !== null && entryTime !== null && entryTime - f.firstSeen < c.flags.freshWalletHours * 3_600_000) {
    // First activity = first transaction of the history (its signature when the origin was found).
    const first = f.history?.origin.found && f.history.origin.signature ? [`tx:${f.history.origin.signature}`] : [];
    add("fresh", "Wallet créé très récemment", "medium", `première activité ${((entryTime - f.firstSeen) / 3_600_000).toFixed(1)} h avant son entrée`, "funding_event", first);
  }
  if (f.fundingTime !== null && ctx.launchTime !== null && ctx.launchTime - f.fundingTime >= 0 && ctx.launchTime - f.fundingTime < c.flags.fundedBeforeLaunchMinutes * 60_000) {
    add("fundedBeforeLaunch", "Financé juste avant le lancement", "high", `${((ctx.launchTime - f.fundingTime) / 60_000).toFixed(1)} min avant la création du token`, "funding_event", f.fundingSignature ? [`tx:${f.fundingSignature}`] : []);
  }
  if (ctx.relatedTo.length) {
    // Funder-based links of this wallet derive from its own funding; any other link is independent evidence.
    const evidence = ctx.relatedLinks
      ? [...new Set(ctx.relatedLinks.map((l) => ((l.type === "sameTx" && l.key !== null && l.key === f.fundingSignature) || ((l.type === "sameFunderClose" || l.type === "sameFunder") && l.key !== null && l.key === f.funder) ? ownFunding : `link:${l.type}:${l.other}`)))]
      : [];
    add("related", "Potentiellement lié à d'autres acheteurs", "medium", ctx.relatedTo.map(short).join(", "), "funding_link", evidence);
  }
  if (f.trades && f.trades.length >= 10) {
    const avg = f.trades.reduce((s, t) => s + t.sol, 0) / f.trades.length;
    if (avg < c.flags.microTicketSol) add("micro", "Micro-transactions", "medium", `ticket moyen ${avg.toFixed(4)} SOL`, "automation", ["ticketSize"]);
    const tokens = new Set(f.trades.filter((t) => t.side === "buy").map((t) => t.mint)).size;
    if ((tokens / Math.max(1, f.signatureCount)) * 100 >= c.flags.tokensPer100Txs && tokens >= 10) {
      add("buysEverything", "Achète presque tous les nouveaux tokens", "low", `${tokens} tokens différents sur ${f.signatureCount} transactions`, "automation", ["tokenBreadth"]);
    }
  }
  // Data status, not a suspicious pattern: it is exactly what makes Quality UNKNOWN.
  if (!f.trades) add("incomplete", "Historique trop incomplet", "low", f.historyNote, "data");
  return dedupePenalties(flags).map((fl) => (fl.group === "data" ? { ...fl, penaltyApplied: false, suppressedBy: null } : fl));
}

const SEVERITY_RANK: Record<WalletFlag["severity"], number> = { high: 3, medium: 2, low: 1 };

/**
 * Within one phenomenon, a flag whose evidence is entirely covered by flags
 * already penalised keeps its description but not its penalty: the strongest
 * existing penalty of the group applies once. A flag without traceable
 * evidence is never suppressed and never covers another one.
 */
export function dedupePenalties(flags: WalletFlag[]): WalletFlag[] {
  const groups = new Set(flags.map((fl) => fl.group).filter((g): g is FlagGroup => g !== null && g !== "data"));
  for (const g of groups) {
    const inGroup = flags.filter((fl) => fl.group === g).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const applied: WalletFlag[] = [];
    for (const fl of inGroup) {
      const covering = fl.evidence.length ? applied.filter((a) => fl.evidence.some((e) => a.evidence.includes(e))) : [];
      const covered = fl.evidence.length > 0 && fl.evidence.every((e) => covering.some((a) => a.evidence.includes(e)));
      if (covered) {
        fl.penaltyApplied = false;
        fl.suppressedBy = covering[0].key;
      } else applied.push(fl);
    }
  }
  return flags;
}

export function profileWallet(f: WalletFacts, ctx: ProfileContext, entryTime: number | null, c: WalletConfig = WALLET_CONFIG): WalletProfile {
  const q = c.quality;
  const creatorLink = classifyCreatorLink(f, ctx);
  const flags = detectFlags(f, ctx, entryTime, c, creatorLink);
  const unknowns: string[] = [...(f.history?.unknowns ?? [])];
  if (creatorLink && (creatorLink.strength === "weak" || creatorLink.strength === "unknown")) unknowns.push(`Lien avec le deployment-associated wallet : ${creatorLink.detail} (non pénalisé).`);
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
    unknowns.push(`Historique non reconstruit : ${f.historyNote}. Trades, PnL, rendements, entrées précoces et durée de détention : UNKNOWN.`);
  }

  // Penalties only exist on a measured score; on an UNKNOWN one the flags are observations.
  const applied = f.trades ? flags.filter((fl) => fl.penaltyApplied && fl.group !== "data") : [];
  const penalty = applied.reduce((s, fl) => s + q.penalties[fl.severity], 0);
  if (penalty) items.push({ label: "Pénalités (motifs suspects)", detail: applied.map((fl) => fl.label).join(", "), points: -penalty, max: 0 });
  const duplicates = f.trades ? flags.filter((fl) => !fl.penaltyApplied && fl.suppressedBy !== null) : [];
  if (duplicates.length) items.push({ label: "Pénalités neutralisées (même preuve)", detail: duplicates.map((fl) => `${fl.label} (déjà couvert par ${flags.find((x) => x.key === fl.suppressedBy)?.label ?? fl.suppressedBy})`).join(", "), points: 0, max: 0 });
  for (const it of items) it.points = r1(it.points);
  const quality: WalletQuality = f.trades
    ? { status: "measured", value: Math.max(0, Math.min(100, Math.round(items.reduce((s, it) => s + it.points, 0)))) }
    : { status: "unknown", reason: qualityUnknownReason(f) };

  const n = metrics?.evaluated ?? 0;
  let confidence: WalletConfidence = f.trades && n >= c.confidence.highMinPositions ? "HIGH" : f.trades && n >= c.confidence.mediumMinPositions ? "MEDIUM" : "LOW";
  if (applied.some((fl) => fl.severity === "high") && confidence === "HIGH") confidence = "MEDIUM";

  const dataConfidence: DataConfidence =
    quality.status === "unknown" ? "UNKNOWN" : n >= c.confidence.highMinPositions ? "HIGH" : n >= c.confidence.mediumMinPositions ? "MEDIUM" : "LOW";

  return { address: f.address, facts: f, metrics, flags, quality, qualityItems: items, confidence, dataConfidence, risk: summarizeRisk(flags, quality), unknowns, creatorLink };
}

export type FlagSeverity = WalletFlag["severity"];

/**
 * Risk observations, derived from the flags only. The data status ("incomplete") is not a risk.
 * On an UNKNOWN Quality no penalty is removed: every flag is an observation and maxApplied is null.
 */
export interface RiskSummary {
  maxObserved: FlagSeverity | null;
  /** Highest severity whose penalty is actually removed from a measured Quality. */
  maxApplied: FlagSeverity | null;
  /** Measured Quality: flags whose penalty applies. */
  applied: WalletFlag[];
  /** Measured Quality: flags kept for description, penalty already covered by the same evidence. */
  neutralised: WalletFlag[];
  /** UNKNOWN Quality: every observed flag, none penalised. */
  observedOnUnknown: WalletFlag[];
}

const maxSeverity = (fs: WalletFlag[]): FlagSeverity | null =>
  fs.reduce<FlagSeverity | null>((m, fl) => (m === null || SEVERITY_RANK[fl.severity] > SEVERITY_RANK[m] ? fl.severity : m), null);

export function summarizeRisk(flags: WalletFlag[], quality: WalletQuality): RiskSummary {
  const risk = flags.filter((fl) => fl.group !== "data");
  const measured = quality.status === "measured";
  const applied = measured ? risk.filter((fl) => fl.penaltyApplied) : [];
  return {
    maxObserved: maxSeverity(risk),
    maxApplied: maxSeverity(applied),
    applied,
    neutralised: measured ? risk.filter((fl) => !fl.penaltyApplied) : [],
    observedOnUnknown: measured ? [] : risk,
  };
}

/** Text form for scripts: "fundedByCreator HIGH", "busy MEDIUM (observé, Quality UNKNOWN)", "aucune". */
export function formatRisk(r: RiskSummary): string {
  const one = (fl: WalletFlag, note = "") => `${fl.key} ${fl.severity.toUpperCase()}${note}`;
  const parts = [
    ...r.applied.map((fl) => one(fl)),
    ...r.neutralised.map((fl) => one(fl, ` (neutralisé : ${fl.suppressedBy})`)),
    ...r.observedOnUnknown.map((fl) => one(fl, " (observé, Quality UNKNOWN)")),
  ];
  return parts.length ? parts.join(", ") : "aucune";
}

/** Why the history could not be scored, from recorded facts only (failure record, history-layer decisions). */
export function qualityUnknownReason(f: WalletFacts): QualityUnknownReason {
  // Only a failure of the history read itself explains the missing trades.
  const hist = f.failure?.stages.find((st) => st.stage === "history");
  if (f.failure && hist) return f.failure.skipped ? { code: "skipped", kind: hist.kind } : { code: "provider_failure", kind: hist.kind };
  const h = f.history;
  const details: IncompleteDetail[] = [];
  if (h) {
    if (h.quickCompletion.skippedReason === "history_too_long") details.push("history_too_long");
    if (h.quickCompletion.attempted && h.quickCompletion.stopReason === "quick_completion_budget") details.push("completion_budget");
    if (h.deep.skippedReason === "deep_disabled") details.push("deep_disabled");
    if (h.deep.attempted) details.push("deep_incomplete");
  }
  return { code: "history_incomplete", details };
}

/** Text form: "74", "UNKNOWN (history_incomplete: history_too_long, deep_disabled)", "UNKNOWN (provider_failure: timeout)". Never 0 for UNKNOWN. */
export function formatQuality(q: WalletQuality): string {
  if (q.status === "measured") return String(q.value);
  const r = q.reason;
  const detail = r.code === "history_incomplete" ? r.details.join(", ") : r.kind;
  return `UNKNOWN (${r.code}${detail ? `: ${detail}` : ""})`;
}

/** Flags split for display: data status, observations that cost points, and the rest (duplicates, or observations on an UNKNOWN score). */
export function presentFlags(p: WalletProfile): { dataStatus: WalletFlag[]; penalised: WalletFlag[]; notPenalised: WalletFlag[] } {
  return {
    dataStatus: p.flags.filter((fl) => fl.group === "data"),
    penalised: p.risk.applied,
    notPenalised: p.quality.status === "measured" ? p.risk.neutralised : p.risk.observedOnUnknown,
  };
}
