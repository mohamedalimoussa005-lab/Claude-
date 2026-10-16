/**
 * Wallet history ingestion on top of the existing WalletHistoryService
 * (providers, cache, cursors). One run walks newest → oldest from the head,
 * page by page, under explicit caps, and says exactly why it stopped.
 *
 * Why not `getFullHistory`: it hides the per-page facts this agent needs
 * (transactions that were listed but could not be retrieved, the stop reason
 * of a budget) and resumes from a saved cursor, which silently skips
 * everything newer than the first run. Starting from the head every time is
 * correct, and cached transactions are not downloaded again (only the
 * signature listing is repeated).
 *
 * A history is COMPLETE only when ALL of these hold: the provider reported the
 * end of the history, no listed transaction was unretrievable, and the source
 * is trusted to be the whole history. Anything else is TRUNCATED and the
 * PnL layer treats it as an incomplete history.
 */

import type { ServicePage, WalletHistoryService } from "../../history/service.ts";
import { HistoryUnavailableError } from "../../history/provider.ts";
import type { HistoryProviderName, HistoryTx, TraceStep } from "../../history/types.ts";
import type { CallBudget } from "./budget.ts";

export type IngestStop = "end_of_history" | "max_pages" | "max_transactions" | "budget_exhausted" | "error" | "stalled" | "missing_transactions" | "source_not_guaranteed";

export interface IngestOptions {
  maxPages: number;
  maxTransactions: number;
  pageLimit: number;
  budget?: CallBudget;
  /**
   * Worst-case requests / estimated credits of a page of `n` transactions. With a budget, a page is shrunk (or skipped)
   * when it could not be finished, instead of burning credits on a page that would be lost.
   */
  pageCost?: (n: number) => { calls: number; credits: number };
  /** false for saved / fixture sources whose completeness nobody guarantees. Default true. */
  historyEndTrusted?: boolean;
}

export interface WalletIngest {
  wallet: string;
  /** Every transaction collected in this run, newest first. */
  txs: HistoryTx[];
  complete: boolean;
  stopReason: IngestStop;
  pages: number;
  /** HTTP requests the providers reported. */
  providerCalls: number;
  providers: HistoryProviderName[];
  listed: number;
  downloaded: number;
  fromCache: number;
  /** Failed transactions skipped when the source reports them (null when it filters them server-side). */
  failedSkipped: number | null;
  /** Listed but unretrievable: holes in the history. */
  missing: number;
  oldestTime: number | null;
  newestTime: number | null;
  trace: TraceStep[];
  failureKinds: string[];
  notes: string[];
}

function addTrace(into: TraceStep[], steps: TraceStep[]): void {
  for (const s of steps) {
    const hit = into.find((t) => t.source === s.source && t.result === s.result && t.cause === s.cause);
    if (hit) hit.count = (hit.count ?? 1) + 1;
    else into.push({ ...s, count: 1 });
  }
}

export async function ingestWallet(service: WalletHistoryService, wallet: string, o: IngestOptions): Promise<WalletIngest> {
  const seen = new Map<string, HistoryTx>();
  const providers = new Set<HistoryProviderName>();
  const trace: TraceStep[] = [];
  const failureKinds = new Set<string>();
  const notes: string[] = [];
  let pages = 0;
  let providerCalls = 0;
  let listed = 0;
  let downloaded = 0;
  let fromCache = 0;
  let failedSkipped: number | null = 0;
  let missing = 0;
  let cursor: string | null = null;
  let stop: IngestStop;

  for (;;) {
    if (pages >= o.maxPages) {
      stop = "max_pages";
      break;
    }
    if (seen.size >= o.maxTransactions) {
      stop = "max_transactions";
      break;
    }
    if (o.budget?.exhaustedBy) {
      stop = "budget_exhausted";
      break;
    }
    let limit = Math.min(o.pageLimit, o.maxTransactions - seen.size);
    if (o.budget && o.pageCost) {
      while (limit > 0 && !o.budget.canAfford(o.pageCost(limit).calls, o.pageCost(limit).credits)) limit = Math.floor(limit / 2);
      if (limit === 0) {
        stop = "budget_exhausted";
        break;
      }
    }
    let page: ServicePage;
    try {
      page = await service.getHistoryPage(wallet, { order: "desc", cursor, limit });
    } catch (e) {
      if (e instanceof HistoryUnavailableError) {
        addTrace(trace, e.failures.flatMap((f) => f.trace));
        for (const f of e.failures) failureKinds.add(f.kind);
      }
      stop = o.budget?.exhaustedBy ? "budget_exhausted" : "error";
      break;
    }
    pages++;
    providerCalls += page.calls;
    providers.add(page.provider);
    addTrace(trace, page.trace);
    listed += page.stats.signaturesListed;
    downloaded += page.stats.transactionsFetched;
    fromCache += page.stats.transactionsFromCache;
    failedSkipped = failedSkipped === null || page.stats.transactionsFailed === null ? null : failedSkipped + page.stats.transactionsFailed;
    missing += page.missing;
    if (page.restarted) notes.push("un fournisseur a redémarré la pagination depuis le début");
    for (const tx of page.txs) seen.set(tx.signature, tx);
    if (!page.nextCursor) {
      stop = missing > 0 ? "missing_transactions" : o.historyEndTrusted === false ? "source_not_guaranteed" : "end_of_history";
      break;
    }
    if (page.nextCursor === cursor) {
      stop = "stalled";
      break;
    }
    cursor = page.nextCursor;
  }

  const txs = [...seen.values()].sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0) || (b.time ?? 0) - (a.time ?? 0));
  const times = txs.map((t) => t.time).filter((t): t is number => t !== null);
  if (stop === "missing_transactions") notes.push(`${missing} transaction(s) listée(s) mais non récupérable(s) : l'historique a des trous`);
  if (stop === "source_not_guaranteed") notes.push("fin de la source atteinte, mais elle n'est pas garantie complète (source hors-ligne)");
  return {
    wallet,
    txs,
    complete: stop === "end_of_history",
    stopReason: stop,
    pages,
    providerCalls,
    providers: [...providers],
    listed,
    downloaded,
    fromCache,
    failedSkipped,
    missing,
    oldestTime: times.length ? Math.min(...times) : null,
    newestTime: times.length ? Math.max(...times) : null,
    trace,
    failureKinds: [...failureKinds],
    notes,
  };
}
