/**
 * GET /api/wallet-history?address=<base58>&mode=quick|deep
 *
 * Local-only backend around WalletHistoryService (step 4.1). Returns
 * normalized transactions, the provider used, completeness and resumability,
 * and non-sensitive error codes. Never returns the Helius key, a Helius URL,
 * environment values or provider error messages (those stay in server logs,
 * already redacted by the provider).
 *
 * DEEP spends provider credits, so it needs: a configured
 * WALLET_HISTORY_DEEP_TOKEN, a matching `Authorization: Bearer` header and a
 * loopback client. QUICK is rate-limited. Both share a concurrency cap, a
 * timeout, a per-analysis budget and a response size cap.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryHistoryCache } from "../src/history/cache.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import type { HistoryConfig } from "../src/history/config.ts";
import { HistoryUnavailableError } from "../src/history/provider.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import type { HistoryProviderName, HistoryTx, WalletHistoryProvider } from "../src/history/types.ts";
import { SERVER_CONFIG } from "./config.ts";
import type { ServerConfig } from "./config.ts";
import { ConcurrencyGate, hostAllowed, isLoopback, parseQuery, TimeoutError, tokenMatches, WindowRateLimiter, withTimeout } from "./guards.ts";
import type { Mode } from "./guards.ts";
import type { SnapshotStore } from "./snapshotStore.ts";

export const ROUTE = "/api/wallet-history";

export interface WalletHistoryResponse {
  address: string;
  mode: Mode;
  provider: HistoryProviderName | null;
  providers: HistoryProviderName[];
  complete: boolean;
  resumable: boolean;
  stopReason: string | null;
  pagination: { pagesThisRun: number; pagesTotal: number };
  origin: { firstSeen: number | null; reachedStart: boolean } | null;
  transactionCount: number;
  truncated: boolean;
  transactions: HistoryTx[];
  /** Providers that failed before one answered: provider + error kind only. */
  warnings: { provider: HistoryProviderName; kind: string }[];
}

export interface AppLog {
  (e: { status: number; mode: Mode | null; ms: number; error?: string; detail?: string }): void;
}

export interface WalletHistoryAppOptions {
  providers: WalletHistoryProvider[];
  store?: SnapshotStore;
  cache?: MemoryHistoryCache;
  deepToken: string | null;
  config?: ServerConfig;
  historyConfig?: HistoryConfig;
  now?: () => number;
  log?: AppLog;
}

const MESSAGES: Record<string, string> = {
  invalid_address: "address must be a base58 Solana address (32 bytes)",
  invalid_mode: "mode must be 'quick' or 'deep'",
  unknown_parameter: "only 'address' and 'mode' are accepted",
  not_found: "unknown route",
  method_not_allowed: "only GET is allowed",
  forbidden_host: "host not allowed",
  rate_limited: "too many requests",
  busy: "too many analyses running, retry later",
  timeout: "analysis timed out; a DEEP analysis resumes on the next call",
  deep_disabled: "DEEP is disabled on this server",
  deep_forbidden: "DEEP needs a local client and a valid server token",
  upstream_unavailable: "no history provider could serve the request",
  response_too_large: "response too large",
  internal_error: "internal error",
};

export function createWalletHistoryApp(o: WalletHistoryAppOptions) {
  const config = o.config ?? SERVER_CONFIG;
  const historyConfig = o.historyConfig ?? HISTORY_CONFIG;
  const cache = o.cache ?? o.store?.load() ?? undefined;
  if (!cache) throw new Error("a cache or a snapshot store is required");
  const limiter = new WindowRateLimiter(config.rateLimit.windowMs, o.now);
  const gate = new ConcurrencyGate(config.maxConcurrent);
  const now = o.now ?? Date.now;
  let saving: Promise<void> = Promise.resolve();

  const persist = () => {
    if (!o.store) return;
    saving = saving.then(() => {
      try {
        o.store!.save(cache);
      } catch {
        o.log?.({ status: 0, mode: null, ms: 0, error: "snapshot_save_failed" });
      }
    });
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(Buffer.byteLength(text)),
      ...headers,
    });
    res.end(text);
  };
  const fail = (res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    send(res, status, { error: code, message: MESSAGES[code] ?? code, ...extra }, headers);

  /** Drops the oldest transactions until the JSON fits the size cap. */
  const fit = (r: WalletHistoryResponse): string | null => {
    let text = JSON.stringify(r);
    if (Buffer.byteLength(text) <= config.maxResponseBytes) return text;
    let lo = 0;
    let hi = r.transactions.length;
    const all = r.transactions;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const size = Buffer.byteLength(JSON.stringify({ ...r, truncated: true, transactions: all.slice(0, mid) }));
      if (size <= config.maxResponseBytes) lo = mid;
      else hi = mid - 1;
    }
    text = JSON.stringify({ ...r, truncated: true, transactions: all.slice(0, lo) });
    return Buffer.byteLength(text) <= config.maxResponseBytes ? text : null;
  };

  async function analyze(address: string, mode: Mode): Promise<WalletHistoryResponse> {
    // One service per request: providers (and their state) and the cache are shared.
    const service = new WalletHistoryService({ providers: o.providers, cache, config: historyConfig, now });
    if (mode === "quick") {
      const q = await service.quick(address);
      const seen = new Set<string>();
      const txs = [...q.recent.txs, ...q.oldest.txs].filter((t) => !seen.has(t.signature) && !!seen.add(t.signature));
      const warnings = [...q.recent.failures, ...q.oldest.failures].map((f) => ({ provider: f.provider, kind: f.kind }));
      return {
        address,
        mode,
        provider: q.recent.provider,
        providers: [...new Set([q.recent.provider, q.oldest.provider])],
        complete: q.recent.nextCursor === null,
        resumable: false,
        stopReason: null,
        pagination: { pagesThisRun: 2, pagesTotal: 2 },
        origin: { firstSeen: q.firstSeen, reachedStart: q.oldest.reachedStart ?? false },
        transactionCount: txs.length,
        truncated: false,
        transactions: txs,
        warnings,
      };
    }
    const d = await service.getFullHistory(address, {
      maxPages: Math.min(config.deep.maxPages, historyConfig.deep.maxPages),
      maxTransactions: Math.min(config.deep.maxTransactions, historyConfig.deep.maxTransactions),
    });
    if (d.stopReason === "error" && d.pagesThisRun === 0 && d.txs.length === 0) throw new HistoryUnavailableError(d.failures ?? []);
    return {
      address,
      mode,
      provider: d.providers[0] ?? null,
      providers: d.providers,
      complete: d.complete,
      resumable: !d.complete,
      stopReason: d.stopReason,
      pagination: { pagesThisRun: d.pagesThisRun, pagesTotal: d.pagesTotal },
      origin: null,
      transactionCount: d.txs.length,
      truncated: false,
      transactions: d.txs,
      warnings: (d.failures ?? []).map((f) => ({ provider: f.provider, kind: f.kind })),
    };
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    let mode: Mode | null = null;
    const done = (status: number, error?: string, detail?: string) => o.log?.({ status, mode, ms: now() - started, ...(error ? { error } : {}), ...(detail ? { detail } : {}) });
    try {
      if (!hostAllowed(req.headers.host, config.allowedHosts)) return fail(res, 403, "forbidden_host"), done(403, "forbidden_host");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== ROUTE) return fail(res, 404, "not_found"), done(404, "not_found");
      if (req.method !== "GET") return fail(res, 405, "method_not_allowed", {}, { allow: "GET" }), done(405, "method_not_allowed");
      const q = parseQuery(url.searchParams);
      if (!q.ok) return fail(res, 400, q.error), done(400, q.error);
      mode = q.mode;

      if (mode === "deep") {
        if (!o.deepToken) return fail(res, 403, "deep_disabled"), done(403, "deep_disabled");
        if (!isLoopback(req.socket.remoteAddress) || !tokenMatches(req.headers.authorization, o.deepToken)) return fail(res, 403, "deep_forbidden"), done(403, "deep_forbidden");
      }
      const client = req.socket.remoteAddress ?? "unknown";
      const wait = limiter.take(`${client}:${mode}`, mode === "deep" ? config.rateLimit.deepPerWindow : config.rateLimit.quickPerWindow);
      if (wait > 0) return fail(res, 429, "rate_limited", {}, { "retry-after": String(wait) }), done(429, "rate_limited");
      if (!gate.tryEnter()) return fail(res, 503, "busy", {}, { "retry-after": "5" }), done(503, "busy");

      // The slot is released when the analysis really ends, not when the HTTP answer times out.
      const work = analyze(q.address, mode).finally(() => {
        gate.leave();
        persist();
      });
      work.catch(() => undefined);
      let result: WalletHistoryResponse;
      try {
        result = await withTimeout(work, config.timeoutMs);
      } catch (e) {
        if (e instanceof TimeoutError) return fail(res, 504, "timeout", { resumable: mode === "deep" }), done(504, "timeout");
        if (e instanceof HistoryUnavailableError) {
          const failures = e.failures.map((f) => ({ provider: f.provider, kind: f.kind }));
          return fail(res, 502, "upstream_unavailable", { failures }), done(502, "upstream_unavailable", failures.map((f) => `${f.provider}:${f.kind}`).join(","));
        }
        throw e;
      }
      const text = fit(result);
      if (text === null) return fail(res, 500, "response_too_large"), done(500, "response_too_large");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": String(Buffer.byteLength(text)) });
      res.end(text);
      done(200);
    } catch {
      if (!res.headersSent) fail(res, 500, "internal_error");
      done(500, "internal_error");
    }
  }

  return {
    handler: (req: IncomingMessage, res: ServerResponse) => void handler(req, res),
    cache,
    /** Waits for pending snapshot writes. */
    flush: async () => {
      persist();
      await saving;
    },
    get running() {
      return gate.running;
    },
  };
}
