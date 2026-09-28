/**
 * BROWSER history client. Implements the Wallet Intelligence `HistorySource`
 * (step 4.2) by calling the local backend route /api/wallet-history, which
 * runs WalletHistoryService with the server-side providers (Helius →
 * enhanced fallback → public RPC). The browser never sees a key, an
 * authenticated URL or a provider: it only knows this one route.
 *
 *   quick          → GET ?address&mode=quick
 *   completeRecent → GET ?address&mode=completion&cursor[&pages]
 *                    (the server fixes every other budget)
 *   getFullHistory → refused locally, no request: DEEP is not available from the UI.
 *
 * Failures are thrown as errors Wallet Intelligence already classifies
 * (network, timeout, rate_limited, quota_exhausted…), so a missing backend
 * makes wallets UNKNOWN — there is no silent fallback to another path. Once
 * the backend is unreachable, later calls of the same run fail fast.
 */

import { MemoryHistoryCache } from "./cache.ts";
import { HistoryUnavailableError } from "./provider.ts";
import type { CompletionResult, DeepHistory, QuickHistory, ServicePage } from "./service.ts";
import type { HistoryTx, PageStats } from "./types.ts";
import type { QuickPageRef, WalletHistoryResponse } from "./wire.ts";
import type { HistorySource } from "../wallets/historyFacts.ts";

export const HISTORY_ROUTE = "/api/wallet-history";

/** A backend history call that failed. `kind` is a FailureKind code; the message never carries upstream text. */
export class HistoryHttpError extends Error {
  readonly kind: string;
  readonly status: number | null;
  readonly code: string;
  constructor(kind: string, code: string, status: number | null) {
    super(`wallet history backend: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "HistoryHttpError";
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

export interface HttpHistorySourceOptions {
  /** Origin prefix ("" = same origin, through the Vite /api proxy). */
  baseUrl?: string;
  fetch?: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
  /** Client-side timeout per request (the server has its own). */
  timeoutMs?: number;
  /** Longest server-requested wait (retry-after) honoured once on 429 / 503. */
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const KIND_BY_ERROR: Record<string, string> = {
  timeout: "timeout",
  rate_limited: "rate_limited",
  busy: "rate_limited",
  response_too_large: "invalid_response",
};

export class HttpHistorySource implements HistorySource {
  readonly cache = new MemoryHistoryCache();
  private readonly base: string;
  private readonly fetchImpl: NonNullable<HttpHistorySourceOptions["fetch"]>;
  private readonly timeoutMs: number;
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Set when the backend could not be reached: later calls fail without a request. */
  private down: HistoryHttpError | null = null;
  /** Every URL requested (path + query only), for diagnostics and tests. */
  readonly requested: string[] = [];

  constructor(o: HttpHistorySourceOptions = {}) {
    this.base = o.baseUrl ?? "";
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = o.timeoutMs ?? 90_000;
    this.maxRetryWaitMs = o.maxRetryWaitMs ?? 30_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async quick(address: string): Promise<QuickHistory> {
    const r = await this.get({ address, mode: "quick" });
    if (!r.quick || r.truncated) throw new HistoryHttpError("invalid_response", r.truncated ? "response_truncated" : "missing_quick", 200);
    const byId = new Map(r.transactions.map((t) => [t.signature, t]));
    for (const t of r.transactions) this.cache.putTx(address, t);
    const page = (ref: QuickPageRef, stats: PageStats | null): ServicePage => {
      const txs = ref.signatures.map((s) => byId.get(s)).filter((t): t is HistoryTx => !!t);
      if (txs.length !== ref.signatures.length) throw new HistoryHttpError("invalid_response", "inconsistent_page", 200);
      return { txs, nextCursor: ref.nextCursor, provider: ref.provider, strategy: ref.strategy, calls: 0, missing: stats?.missing ?? 0, stats: stats ?? emptyStats(txs.length), trace: [], failures: [], newTxs: 0 };
    };
    const q = r.quick;
    return {
      address,
      status: q.status,
      recent: { page: page(q.recent.page, q.recent.stats), stats: q.recent.stats, complete: q.recent.complete },
      origin: q.origin,
      originPage: q.originPage ? page(q.originPage, null) : null,
      trace: q.trace,
      calls: 1,
    };
  }

  async completeRecent(address: string, cursor: string, opts: { maxPages: number; maxTransactions: number; pageLimit: number }): Promise<CompletionResult> {
    // Only the page count travels; transactions and page size are fixed by the server.
    const r = await this.get({ address, mode: "completion", cursor, pages: String(Math.max(1, Math.floor(opts.maxPages))) });
    if (!r.completion || r.truncated) throw new HistoryHttpError("invalid_response", r.truncated ? "response_truncated" : "missing_completion", 200);
    for (const t of r.transactions) this.cache.putTx(address, t);
    return { txs: r.transactions, reachedEnd: r.completion.reachedEnd, stopReason: r.completion.stopReason, pages: r.completion.pages, calls: 1, trace: r.completion.trace };
  }

  async getFullHistory(): Promise<DeepHistory> {
    throw new HistoryHttpError("method_unavailable", "deep_not_available_from_ui", null);
  }

  private async get(params: Record<string, string>): Promise<WalletHistoryResponse> {
    if (this.down) throw this.down;
    const path = `${HISTORY_ROUTE}?${new URLSearchParams(params).toString()}`;
    for (let attempt = 0; ; attempt++) {
      this.requested.push(path);
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
      let res: Awaited<ReturnType<NonNullable<HttpHistorySourceOptions["fetch"]>>>;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, { signal: ctl?.signal, headers: { accept: "application/json" } });
      } catch (e) {
        if (timer) clearTimeout(timer);
        if ((e as { name?: string })?.name === "AbortError") throw new HistoryHttpError("timeout", "client_timeout", null);
        // Backend not running / proxy down: UNKNOWN for this run, no other path.
        this.down = new HistoryHttpError("network", "backend_unreachable", null);
        throw this.down;
      }
      if (timer) clearTimeout(timer);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (res.status >= 500) {
          // The dev proxy answers 5xx without JSON when the backend is down.
          this.down = new HistoryHttpError("network", "backend_unreachable", res.status);
          throw this.down;
        }
        throw new HistoryHttpError("invalid_response", "invalid_json", res.status);
      }
      if (res.ok) return body as WalletHistoryResponse;
      const err = body as { error?: string; failures?: { provider?: string; kind?: string }[] };
      const code = typeof err?.error === "string" ? err.error : "http_error";
      if ((res.status === 429 || res.status === 503) && attempt === 0) {
        const wait = Number(res.headers.get("retry-after") ?? "5") * 1000;
        if (Number.isFinite(wait) && wait >= 0 && wait <= this.maxRetryWaitMs) {
          await this.sleep(wait);
          continue;
        }
      }
      if (code === "upstream_unavailable" && Array.isArray(err.failures)) {
        // Provider + kind codes only: lets Wallet Intelligence stop after a spent quota, as on the server.
        throw new HistoryUnavailableError(err.failures.map((f) => ({ provider: f.provider === "public_rpc" ? "public_rpc" : "helius", kind: String(f.kind ?? "unknown"), message: String(f.kind ?? "unknown"), trace: [] })));
      }
      throw new HistoryHttpError(KIND_BY_ERROR[code] ?? "unknown", code, res.status);
    }
  }
}

function emptyStats(n: number): PageStats {
  return { signaturesRequested: n, signaturesListed: n, transactionsFetched: 0, transactionsFromCache: 0, transactionsSucceeded: null, transactionsFailed: null, transactionsNormalized: n, missing: 0 };
}

/** Parsed but typed loosely on purpose: the browser only trusts the fields it reads. */
export type { WalletHistoryResponse };
