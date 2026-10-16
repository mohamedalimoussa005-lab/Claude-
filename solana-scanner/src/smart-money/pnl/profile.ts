/** Ledger + FIFO + statistics → one explainable wallet PnL profile. */

import type { HistoryTx } from "../../history/types.ts";
import type { HistoryExtras } from "../../wallets/types.ts";
import { DEFAULT_THRESHOLDS } from "../config.ts";
import type { SmartMoneyConfig } from "../config.ts";
import { buildLedger } from "../ledger/build.ts";
import type { HistoryCoverage, Ledger } from "../ledger/types.ts";
import { computePnl } from "./fifo.ts";
import { consistency, winRate } from "./stats.ts";
import type { Consistency, WinRate } from "./stats.ts";
import type { MarkPrice, OpenPosition, PnlResult, Round } from "./types.ts";

export interface PnlTotals {
  rounds: number;
  /** Trading cost / proceeds (fees, tips, rent excluded). */
  cost: number;
  proceeds: number;
  tradingPnl: number;
  feesSol: number;
  tipsSol: number;
  /** Result after fees and tips. */
  realized: number;
}

export interface WalletPnlProfile {
  wallet: string;
  coverage: HistoryCoverage;
  counts: { known: number; partial: number; provisional: number; unknown: number; open: number };
  /** Share of closed positions whose outcome is known (KNOWN / all closed). null when nothing closed. */
  knownShare: number | null;
  unknownReasons: Record<string, number>;
  /** KNOWN rounds only; SOL and USD are never added together. */
  totals: { sol: PnlTotals; usd: PnlTotals };
  winRate: WinRate;
  consistency: Consistency;
  open: OpenPosition[];
  failedFeeSol: number;
  /** Every cost that is not trading, over the whole ledger (positions or not). Rent is capital, shown apart. */
  costs: PnlResult["costs"] & { rentNetLockedSol: number };
  caveats: string[];
}

/** Maps the history layer's completeness label to a coverage flag. */
export function coverageFromCompleteness(c: HistoryExtras["completeness"], oldestTime: number | null = null): HistoryCoverage {
  return { complete: c === "recent_page_covers_history" || c === "quick_completion_complete" || c === "deep_complete", oldestTime };
}

const sum = (rs: Round[], f: (r: Round) => number | null) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
const totalsOf = (rs: Round[]): PnlTotals => ({
  rounds: rs.length,
  cost: sum(rs, (r) => r.cost),
  proceeds: sum(rs, (r) => r.proceeds),
  tradingPnl: sum(rs, (r) => r.tradingPnl),
  feesSol: sum(rs, (r) => r.feesSol),
  tipsSol: sum(rs, (r) => r.tipsSol),
  realized: sum(rs, (r) => r.pnl),
});

export function profileFromPnl(r: PnlResult, config: Pick<SmartMoneyConfig, "thresholds"> = { thresholds: DEFAULT_THRESHOLDS }): WalletPnlProfile {
  const known = r.rounds.filter((x) => x.status === "KNOWN");
  const knownSol = known.filter((x) => x.quote === "SOL");
  const knownUsd = known.filter((x) => x.quote === "USD");
  const unknownRounds = r.rounds.filter((x) => x.status === "UNKNOWN");
  const provisional = r.rounds.filter((x) => x.status === "PROVISIONAL");
  const partial = r.rounds.filter((x) => x.status === "PARTIAL");
  const unknownReasons: Record<string, number> = {};
  for (const u of unknownRounds) for (const reason of u.unknownReasons) unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;

  const wr = winRate(known, config.thresholds);
  const caveats: string[] = [];
  if (!r.coverage.complete) caveats.push("Historique incomplet : les positions propres sont PROVISOIRES et exclues du taux de réussite.");
  if (wr.sample === "insufficient") caveats.push(`Échantillon insuffisant : ${wr.n} position(s) fermée(s) connue(s) sur ${wr.minRequired} requises. Les chiffres sont descriptifs, pas une preuve de compétence.`);
  if (partial.length > 0) caveats.push(`${partial.length} position(s) PARTIELLE(S) : du rent de compte n'a pas pu être séparé avec certitude du montant des trades ; leur PnL est approximatif et exclu des totaux et du taux de réussite.`);
  if (unknownRounds.length > 0) caveats.push(`${unknownRounds.length} position(s) fermée(s) au résultat INCONNU, exclue(s) des totaux et du taux de réussite.`);
  if (r.open.length > 0) caveats.push(`${r.open.length} position(s) ouverte(s) : leur valeur latente n'est pas dans le PnL réalisé.`);
  if (knownUsd.length > 0) caveats.push("Les PnL en USD (stablecoins pris à 1 USD) ne sont pas additionnés aux PnL en SOL : aucun taux SOL/USD n'est supposé.");
  const totalClosed = r.rounds.length;
  return {
    wallet: r.wallet,
    coverage: r.coverage,
    counts: { known: known.length, partial: partial.length, provisional: provisional.length, unknown: unknownRounds.length, open: r.open.length },
    knownShare: totalClosed ? known.length / totalClosed : null,
    unknownReasons,
    totals: { sol: totalsOf(knownSol), usd: totalsOf(knownUsd) },
    winRate: wr,
    consistency: consistency(knownSol),
    open: r.open,
    failedFeeSol: r.failedFeeSol,
    costs: { ...r.costs, rentNetLockedSol: r.costs.rentDepositedSol - r.costs.rentRecoveredSol },
    caveats,
  };
}

export interface AnalyzeOptions {
  coverage: HistoryCoverage;
  config?: Pick<SmartMoneyConfig, "thresholds" | "tipAccounts">;
  marks?: Record<string, MarkPrice>;
}

/** The whole phase 1 + 2 pipeline for one wallet. */
export function analyzeWallet(wallet: string, txs: HistoryTx[], o: AnalyzeOptions): { ledger: Ledger; pnl: PnlResult; profile: WalletPnlProfile } {
  const thresholds = o.config?.thresholds ?? DEFAULT_THRESHOLDS;
  const ledger = buildLedger(wallet, txs, { thresholds, tipAccounts: o.config?.tipAccounts });
  const pnl = computePnl(ledger, { coverage: o.coverage, thresholds, marks: o.marks });
  return { ledger, pnl, profile: profileFromPnl(pnl, { thresholds }) };
}
