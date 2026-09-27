/**
 * Wallet history service: provider-independent access to wallet histories.
 *
 * - Providers are tried in order (e.g. Helius, then public RPC); a failing
 *   provider hands over to the next one for that request.
 * - Transactions are de-duplicated by signature and cached; finalized
 *   transactions already cached are never downloaded again.
 * - QUICK = recent activity (one page, newest first) + wallet origin (one page,
 *   oldest first). Small, fixed call budget.
 * - DEEP = paginated history, newest → oldest, bounded by maxPages /
 *   maxTransactions, resumable (pagination state saved after each page).
 *   Only for explicitly selected wallets, capped per instance.
 * No scoring, no classification into positions here.
 */

import { HISTORY_CONFIG } from "./config.ts";
import type { HistoryConfig } from "./config.ts";
import { MemoryHistoryCache } from "./cache.ts";
import type { HistoryCache, PaginationState } from "./cache.ts";
import { HistoryUnavailableError, ProviderUnavailableError } from "./provider.ts";
import type { ProviderFailure } from "./provider.ts";
import type { HistoryOrder, HistoryPage, HistoryProviderName, HistoryTx, WalletHistoryProvider } from "./types.ts";

export interface ServicePage extends HistoryPage {
  /** Providers that failed before this one answered. */
  failures: ProviderFailure[];
  /** Transactions not seen before this call. */
  newTxs: number;
}

export interface QuickHistory {
  address: string;
  recent: ServicePage;
  oldest: ServicePage;
  /** Time of the oldest transaction, only when the start of the history was reached. */
  firstSeen: number | null;
  calls: number;
}

export type DeepStopReason = "end_of_history" | "max_pages" | "max_transactions" | "error" | "stalled" | "cached";

export interface DeepHistory {
  address: string;
  /** Every transaction known for the wallet, newest first. */
  txs: HistoryTx[];
  complete: boolean;
  stopReason: DeepStopReason;
  pagesThisRun: number;
  pagesTotal: number;
  calls: number;
  providers: HistoryProviderName[];
  error?: string;
  /** Provider failures behind an "error" stop. */
  failures?: ProviderFailure[];
}

export interface DeepOptions {
  maxPages?: number;
  maxTransactions?: number;
  pageLimit?: number;
}

const DEEP_KEY = "deep";

export class WalletHistoryService {
  private readonly providers: WalletHistoryProvider[];
  readonly cache: HistoryCache;
  private readonly config: HistoryConfig;
  private readonly now: () => number;
  private readonly deepWallets = new Set<string>();

  constructor(o: { providers: WalletHistoryProvider[]; cache?: HistoryCache; config?: HistoryConfig; now?: () => number }) {
    this.providers = o.providers;
    this.cache = o.cache ?? new MemoryHistoryCache();
    this.config = o.config ?? HISTORY_CONFIG;
    this.now = o.now ?? Date.now;
  }

  /** One page from the first provider that can serve it. */
  async getHistoryPage(address: string, req: { order: HistoryOrder; cursor: string | null; limit: number }): Promise<ServicePage> {
    const failures: ServicePage["failures"] = [];
    for (const p of this.providers) {
      let page: HistoryPage;
      try {
        page = await p.getPage({ address, ...req, cached: (s) => this.cache.getTx(s) });
      } catch (e) {
        failures.push({ provider: p.name, kind: e instanceof ProviderUnavailableError ? e.kind : "error", message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const seen = new Set<string>();
      const txs: HistoryTx[] = [];
      let newTxs = 0;
      for (const tx of page.txs) {
        if (seen.has(tx.signature)) continue;
        seen.add(tx.signature);
        if (!this.cache.getTx(tx.signature)) newTxs++;
        this.cache.putTx(address, tx);
        txs.push(tx);
      }
      return { ...page, txs, failures, newTxs };
    }
    throw new HistoryUnavailableError(failures);
  }

  getRecentHistory(address: string, limit = this.config.quick.recentLimit): Promise<ServicePage> {
    return this.getHistoryPage(address, { order: "desc", cursor: null, limit });
  }

  getOldestHistory(address: string, limit = this.config.quick.oldestLimit): Promise<ServicePage> {
    return this.getHistoryPage(address, { order: "asc", cursor: null, limit });
  }

  /** QUICK: recent activity + origin, two pages at most. */
  async quick(address: string): Promise<QuickHistory> {
    const recent = await this.getRecentHistory(address);
    const oldest = await this.getOldestHistory(address);
    const first = oldest.reachedStart ? oldest.txs.find((t) => t.time !== null) : undefined;
    return { address, recent, oldest, firstSeen: first?.time ?? null, calls: recent.calls + oldest.calls };
  }

  /** DEEP: paginated history of a selected wallet, resumable. */
  async getFullHistory(address: string, opts: DeepOptions = {}): Promise<DeepHistory> {
    const c = this.config.deep;
    const maxPages = opts.maxPages ?? c.maxPages;
    const maxTransactions = opts.maxTransactions ?? c.maxTransactions;
    const pageLimit = opts.pageLimit ?? c.pageLimit;
    if (!this.deepWallets.has(address) && this.deepWallets.size >= c.maxWalletsPerRun) {
      throw new Error(`DEEP history is limited to ${c.maxWalletsPerRun} selected wallets per run`);
    }
    this.deepWallets.add(address);

    const state: PaginationState = this.cache.getState(address, DEEP_KEY) ?? { wallet: address, key: DEEP_KEY, cursor: null, pages: 0, transactions: 0, done: false, stopReason: null, updatedAt: this.now() };
    const known = new Map(this.cache.walletTxs(address).map((t) => [t.signature, t]));
    const providers = new Set<HistoryProviderName>();
    let pagesThisRun = 0;
    let calls = 0;
    let stop: DeepStopReason;
    let error: string | undefined;
    let failures: ProviderFailure[] | undefined;
    const save = (reason: DeepStopReason | null) => {
      state.transactions = known.size;
      state.stopReason = reason;
      state.updatedAt = this.now();
      this.cache.putState(state);
    };

    if (state.done) {
      stop = "cached";
    } else {
      for (;;) {
        if (pagesThisRun >= maxPages) {
          stop = "max_pages";
          break;
        }
        if (known.size >= maxTransactions) {
          stop = "max_transactions";
          break;
        }
        let page: ServicePage;
        try {
          page = await this.getHistoryPage(address, { order: "desc", cursor: state.cursor, limit: Math.min(pageLimit, maxTransactions - known.size) });
        } catch (e) {
          stop = "error";
          error = e instanceof Error ? e.message : String(e);
          if (e instanceof HistoryUnavailableError) failures = e.failures;
          break;
        }
        pagesThisRun++;
        calls += page.calls;
        providers.add(page.provider);
        for (const tx of page.txs) known.set(tx.signature, tx);
        const previous = state.cursor;
        state.cursor = page.nextCursor;
        state.pages++;
        if (!page.nextCursor || page.txs.length === 0) {
          state.done = true;
          save("end_of_history");
          stop = "end_of_history";
          break;
        }
        if (page.nextCursor === previous) {
          save("stalled");
          stop = "stalled";
          break;
        }
        save(null);
      }
    }
    if (stop !== "end_of_history") save(stop === "cached" ? "end_of_history" : stop);
    const txs = [...known.values()].sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0) || (b.time ?? 0) - (a.time ?? 0));
    return {
      address,
      txs,
      complete: state.done,
      stopReason: stop,
      pagesThisRun,
      pagesTotal: state.pages,
      calls,
      providers: [...providers],
      ...(error ? { error } : {}),
      ...(failures ? { failures } : {}),
    };
  }
}
