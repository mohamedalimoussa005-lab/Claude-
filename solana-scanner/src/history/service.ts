/**
 * Wallet history service: provider-independent access to wallet histories.
 *
 * - Providers are tried in order (e.g. Helius, then public RPC); a failing
 *   provider hands over to the next one for that request. Every step is kept
 *   as a non-sensitive trace (fixed codes only).
 * - Transactions are de-duplicated by signature and cached; finalized
 *   transactions already cached are never downloaded again. Failed
 *   transactions are counted, never returned.
 * - QUICK = two separate results with a fixed call budget:
 *     recent  one page, newest first (activity);
 *     origin  the wallet's first transaction, when reachable within budget
 *             (a missing origin is a status, not an error).
 * - DEEP = paginated history, newest → oldest, bounded by maxPages /
 *   maxTransactions, resumable (pagination state saved after each page).
 *   Only for explicitly selected wallets, capped per instance.
 * No scoring, no classification into positions here.
 */

import { HISTORY_CONFIG } from "./config.ts";
import type { HistoryConfig } from "./config.ts";
import { MemoryHistoryCache } from "./cache.ts";
import type { CachedOrigin, HistoryCache, PaginationState } from "./cache.ts";
import { HistoryUnavailableError, ProviderUnavailableError, traceResult } from "./provider.ts";
import type { ProviderFailure } from "./provider.ts";
import type { HistoryOrder, HistoryPage, HistoryProviderName, HistoryTx, PageStats, TraceStep, WalletHistoryProvider } from "./types.ts";

export interface ServicePage extends HistoryPage {
  /** Providers that failed before this one answered. */
  failures: ProviderFailure[];
  /** Transactions not seen before this call. */
  newTxs: number;
}

export type OriginReason = "found" | "history_start_reached" | "budget_exhausted" | "primary_unavailable" | "unsupported" | "error";
export type OriginMethod = "helius_primary_asc" | "signature_walk" | "recent_page" | "cache" | "none";

export interface OriginResult {
  found: boolean;
  firstSeen: number | null;
  signature: string | null;
  method: OriginMethod;
  /** true when the answer is definitive (start of history reached). */
  complete: boolean;
  reason: OriginReason;
  /** Signatures listed while looking for the start (failed ones included; never the decoded count). 0 when nothing was listed (cache). */
  signaturesScanned: number;
  /**
   * Exact number of signatures in the wallet's history when the listing
   * reached its start (signature walk or a recent page covering everything);
   * null when unknown (oldest-first provider page, cache, not found).
   */
  totalSignatures: number | null;
}

export type QuickStatus = "quick_complete" | "quick_partial" | "upstream_partial";

export interface QuickHistory {
  address: string;
  status: QuickStatus;
  recent: {
    page: ServicePage;
    stats: PageStats;
    /** The recent page holds the wallet's entire history. */
    complete: boolean;
  };
  origin: OriginResult;
  /** Origin page (when one was fetched). */
  originPage: ServicePage | null;
  trace: { phase: "recent" | "origin"; steps: TraceStep[] }[];
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
  /** Aggregated trace of this run (step + count). */
  trace: TraceStep[];
  error?: string;
  /** Provider failures behind an "error" stop. */
  failures?: ProviderFailure[];
}

export type CompletionStopReason = "quick_completion_end" | "quick_completion_budget" | "stalled" | "error";

/** Pages fetched after QUICK's recent page to finish a short history (not DEEP: no DEEP state, no DEEP cap). */
export interface CompletionResult {
  txs: HistoryTx[];
  /** The end of the history was really reached. */
  reachedEnd: boolean;
  stopReason: CompletionStopReason;
  pages: number;
  calls: number;
  trace: TraceStep[];
}

export interface DeepOptions {
  maxPages?: number;
  maxTransactions?: number;
  pageLimit?: number;
}

const DEEP_KEY = "deep";

/** Trace of a request that failed on every provider. */
export function failureTrace(failures: ProviderFailure[]): TraceStep[] {
  return failures.flatMap((f) => f.trace);
}

function aggregate(into: TraceStep[], steps: TraceStep[]): void {
  for (const s of steps) {
    const hit = into.find((t) => t.source === s.source && t.result === s.result && t.cause === s.cause);
    if (hit) hit.count = (hit.count ?? 1) + 1;
    else into.push({ ...s, count: 1 });
  }
}

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

  /** One page from the first provider that can serve it; `trace` covers every provider tried. */
  async getHistoryPage(address: string, req: { order: HistoryOrder; cursor: string | null; limit: number }): Promise<ServicePage> {
    const failures: ProviderFailure[] = [];
    for (const p of this.providers) {
      let page: HistoryPage;
      try {
        page = await p.getPage({ address, ...req, cached: (s) => this.cache.getTx(s) });
      } catch (e) {
        const kind = e instanceof ProviderUnavailableError ? e.kind : ((e as { kind?: string }).kind ?? "error");
        const trace = e instanceof ProviderUnavailableError && e.trace.length ? e.trace : [{ source: p.name === "helius" ? ("helius_primary" as const) : ("public_rpc" as const), result: traceResult(kind) }];
        failures.push({ provider: p.name, kind, message: e instanceof Error ? e.message : String(e), trace });
        continue;
      }
      const seen = new Set<string>();
      const txs: HistoryTx[] = [];
      let newTxs = 0;
      for (const tx of page.txs) {
        if (seen.has(tx.signature) || tx.failed) continue;
        seen.add(tx.signature);
        if (!this.cache.getTx(tx.signature)) newTxs++;
        this.cache.putTx(address, tx);
        txs.push(tx);
      }
      return { ...page, txs, stats: { ...page.stats, transactionsNormalized: txs.length }, trace: [...failureTrace(failures), ...page.trace], failures, newTxs };
    }
    throw new HistoryUnavailableError(failures);
  }

  getRecentHistory(address: string, limit = this.config.quick.recentLimit): Promise<ServicePage> {
    return this.getHistoryPage(address, { order: "desc", cursor: null, limit });
  }

  getOldestHistory(address: string, limit = this.config.quick.oldestLimit): Promise<ServicePage> {
    return this.getHistoryPage(address, { order: "asc", cursor: null, limit });
  }

  /** QUICK: recent activity + origin. A missing origin never hides the recent activity. */
  async quick(address: string): Promise<QuickHistory> {
    const recent = await this.getRecentHistory(address); // no recent page = nothing usable: the error propagates
    const trace: QuickHistory["trace"] = [{ phase: "recent", steps: recent.trace }];
    const recentComplete = recent.nextCursor === null;
    let calls = recent.calls;
    let origin: OriginResult;
    let originPage: ServicePage | null = null;

    const cached = this.cache.getOrigin(address);
    if (cached) {
      origin = { found: !cached.empty, firstSeen: cached.firstSeen, signature: cached.signature, method: "cache", complete: true, reason: cached.empty ? "history_start_reached" : "found", signaturesScanned: 0, totalSignatures: null };
    } else if (recentComplete) {
      // The recent page already holds the whole history: its oldest transaction is the origin, no extra call.
      const first = [...recent.txs].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || (a.time ?? 0) - (b.time ?? 0))[0];
      origin = { found: !!first, firstSeen: first?.time ?? null, signature: first?.signature ?? null, method: "recent_page", complete: true, reason: first ? "found" : "history_start_reached", signaturesScanned: recent.stats.signaturesListed, totalSignatures: recent.stats.signaturesListed };
    } else {
      try {
        originPage = await this.getOldestHistory(address);
        calls += originPage.calls;
        trace.push({ phase: "origin", steps: originPage.trace });
        origin = originFromPage(originPage);
      } catch (e) {
        const failures = e instanceof HistoryUnavailableError ? e.failures : [];
        trace.push({ phase: "origin", steps: failureTrace(failures) });
        origin = { found: false, firstSeen: null, signature: null, method: "none", complete: false, reason: "error", signaturesScanned: 0, totalSignatures: null };
      }
    }
    if (origin.complete && origin.method !== "cache" && origin.method !== "none") {
      this.cache.putOrigin({ wallet: address, firstSeen: origin.firstSeen, signature: origin.signature, method: origin.method, empty: !origin.found });
    }
    const status: QuickStatus = origin.reason === "error" ? "upstream_partial" : origin.complete ? "quick_complete" : "quick_partial";
    return { address, status, recent: { page: recent, stats: recent.stats, complete: recentComplete }, origin, originPage, trace, calls };
  }

  /**
   * QUICK completion: continue newest → oldest from the recent page's cursor
   * until the end of the history or the (small) budget. Deterministic: at most
   * `maxPages` pages and `maxTransactions` transactions.
   */
  async completeRecent(address: string, cursor: string, opts: { maxPages: number; maxTransactions: number; pageLimit: number }): Promise<CompletionResult> {
    const txs: HistoryTx[] = [];
    const trace: TraceStep[] = [];
    let cur = cursor;
    let pages = 0;
    let calls = 0;
    while (pages < opts.maxPages && txs.length < opts.maxTransactions) {
      let page: ServicePage;
      try {
        page = await this.getHistoryPage(address, { order: "desc", cursor: cur, limit: Math.min(opts.pageLimit, opts.maxTransactions - txs.length) });
      } catch (e) {
        if (e instanceof HistoryUnavailableError) aggregate(trace, failureTrace(e.failures));
        return { txs, reachedEnd: false, stopReason: "error", pages, calls, trace };
      }
      pages++;
      calls += page.calls;
      aggregate(trace, page.trace);
      txs.push(...page.txs);
      if (!page.nextCursor) return { txs, reachedEnd: true, stopReason: "quick_completion_end", pages, calls, trace };
      if (page.nextCursor === cur) return { txs, reachedEnd: false, stopReason: "stalled", pages, calls, trace };
      cur = page.nextCursor;
    }
    return { txs, reachedEnd: false, stopReason: "quick_completion_budget", pages, calls, trace };
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
    const trace: TraceStep[] = [];
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
          if (e instanceof HistoryUnavailableError) {
            failures = e.failures;
            aggregate(trace, failureTrace(e.failures));
          }
          break;
        }
        aggregate(trace, page.trace);
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
      trace,
      ...(error ? { error } : {}),
      ...(failures ? { failures } : {}),
    };
  }
}

/** Origin from an oldest-first page. `signaturesScanned` = signatures listed by the walk, never the transactions decoded. */
export function originFromPage(page: ServicePage): OriginResult {
  const method: OriginMethod = page.strategy === "helius_gtfa" ? "helius_primary_asc" : "signature_walk";
  const scanned = page.walkedSignatures ?? page.stats.signaturesListed;
  // A signature walk that reached the start listed the whole history: its size is exact.
  const total = method === "signature_walk" && (page.originStatus === "reached" || (page.originStatus === undefined && page.reachedStart)) ? scanned : null;
  const base = { method, signaturesScanned: scanned, totalSignatures: total };
  if (page.originStatus === "reached" || (page.originStatus === undefined && page.reachedStart)) {
    const first = page.txs.find((t) => t.time !== null) ?? page.txs[0];
    if (first) return { ...base, found: true, firstSeen: first.time, signature: first.signature, complete: true, reason: "found" };
    return { ...base, found: false, firstSeen: null, signature: null, complete: true, reason: "history_start_reached" };
  }
  const primaryDown = page.trace.some((s) => s.source === "helius_primary" && s.result !== "success" && s.result !== "skipped");
  if (page.originStatus === "unsupported") return { ...base, found: false, firstSeen: null, signature: null, complete: false, reason: primaryDown ? "primary_unavailable" : "unsupported" };
  return { ...base, found: false, firstSeen: null, signature: null, complete: false, reason: "budget_exhausted" };
}

export type { CachedOrigin };
