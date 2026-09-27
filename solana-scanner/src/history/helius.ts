/**
 * Helius wallet-history provider. SERVER-SIDE ONLY: it holds the API key.
 *
 * PRIMARY  getTransactionsForAddress (JSON-RPC), transactionDetails "full",
 *          jsonParsed, paginationToken, asc or desc. Documented "Developer
 *          plan+ only": it is tried, never assumed.
 * FALLBACK getSignaturesForAddress (before-signature paging) + POST
 *          /v0/transactions (enhanced decoding, ≤ 100 per call). Signatures
 *          already in the cache are not downloaded again.
 *
 * PRIMARY → FALLBACK on 403, 404 / method unavailable (sticky for the
 * instance) and on 429 still failing after retries (this call only). 401
 * (key rejected) makes the whole provider unavailable: the service then
 * moves on to the public RPC provider.
 *
 * The key lives in a private field, is only placed in the request URL passed
 * to fetch, and is redacted from every error and log message. It is never
 * serialized, returned, cached or logged.
 */

import { RateLimiter, realSleep } from "../api/rateLimiter.ts";
import type { Sleep } from "../api/rateLimiter.ts";
import type { ParsedTransaction, SignatureInfo } from "../onchain/rpc.ts";
import { HISTORY_CONFIG } from "./config.ts";
import type { HistoryConfig } from "./config.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { normalizeEnhanced, normalizeParsed } from "./normalize.ts";
import type { EnhancedTransaction } from "./normalize.ts";
import { assertServerSide, ProviderUnavailableError, traceResult } from "./provider.ts";
import type { HistoryLogEntry, HistoryPage, HistoryStrategy, HistoryTx, PageRequest, PageStats, TraceStep, WalletHistoryProvider } from "./types.ts";

export type HeliusErrorKind = "auth" | "forbidden" | "unavailable" | "rate_limit" | "http" | "network" | "timeout" | "rpc" | "parse";

export class HeliusError extends Error {
  readonly kind: HeliusErrorKind;
  readonly status: number | null;
  readonly method: string;
  constructor(kind: HeliusErrorKind, method: string, message: string, status: number | null = null) {
    super(message);
    this.name = "HeliusError";
    this.kind = kind;
    this.method = method;
    this.status = status;
  }
}

export interface HeliusProviderOptions {
  apiKey: string;
  config?: HistoryConfig["helius"];
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
  onRequest?: (e: HistoryLogEntry) => void;
}

const RATE_LIMIT_CODES = new Set([429, -32005, -32429]);
const UNAVAILABLE_CODES = new Set([-32601]);
const PLAN_MESSAGE = /plan|upgrade|not (?:available|supported|enabled)|restricted/i;

/** One getTransactionsForAddress "full" item. */
interface GtfaItem {
  slot?: number;
  blockTime?: number | null;
  transaction: ParsedTransaction["transaction"];
  meta: ParsedTransaction["meta"];
}

export class HeliusHistoryProvider implements WalletHistoryProvider {
  readonly name = "helius" as const;
  readonly #apiKey: string;
  readonly #config: HistoryConfig["helius"];
  readonly #fetch: typeof fetch;
  readonly #sleep: Sleep;
  readonly #limiter: RateLimiter;
  readonly #onRequest?: (e: HistoryLogEntry) => void;
  #primaryDisabled: string | null = null;
  #nextId = 1;

  constructor(o: HeliusProviderOptions) {
    assertServerSide("HeliusHistoryProvider");
    if (!o.apiKey || typeof o.apiKey !== "string") throw new Error("Helius API key missing (server-side HELIUS_API_KEY)");
    this.#apiKey = o.apiKey;
    this.#config = o.config ?? HISTORY_CONFIG.helius;
    this.#fetch = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#sleep = o.sleep ?? realSleep;
    this.#limiter = new RateLimiter(this.#config.maxRequestsPerSecond, 1000, o.now ?? Date.now, this.#sleep);
    this.#onRequest = o.onRequest;
  }

  /** Why PRIMARY is off for this instance (null = still tried). */
  get primaryDisabled(): string | null {
    return this.#primaryDisabled;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, primaryDisabled: this.#primaryDisabled };
  }

  toString(): string {
    return "[HeliusHistoryProvider]";
  }

  async getPage(req: PageRequest): Promise<HistoryPage> {
    const cur = decodeCursor(req.cursor);
    const trace: TraceStep[] = [];
    let fallbackNote: string | undefined;
    if (this.#primaryDisabled) {
      trace.push({ source: "helius_primary", result: "disabled", cause: traceResult(this.#primaryDisabled) });
    } else if (cur?.kind === "sig") {
      trace.push({ source: "helius_primary", result: "skipped" });
    } else {
      try {
        const page = await this.#primaryPage(req, cur?.value ?? null);
        trace.push({ source: "helius_primary", result: "success" });
        return { ...page, trace };
      } catch (e) {
        if (!(e instanceof HeliusError)) throw e;
        trace.push({ source: "helius_primary", result: traceResult(e.kind) });
        if (e.kind === "auth") throw new ProviderUnavailableError("helius", "auth", e.message, trace);
        if (e.kind === "forbidden" || e.kind === "unavailable") this.#primaryDisabled = e.kind;
        else if (e.kind !== "rate_limit") throw new ProviderUnavailableError("helius", e.kind, e.message, trace);
        fallbackNote = `getTransactionsForAddress ${e.kind}${e.status ? ` (${e.status})` : ""} → fallback`;
        this.#log("helius_gtfa", "getTransactionsForAddress", 0, e.status, "fallback", fallbackNote);
      }
    }
    try {
      const page = req.order === "asc" ? await this.#fallbackOldest(req) : await this.#fallbackPage(req, cur?.kind === "sig" ? cur.value : null, cur?.kind === "gtfa");
      trace.push({ source: "helius_enhanced", result: "success" });
      if (fallbackNote) page.note = page.note ? `${fallbackNote}; ${page.note}` : fallbackNote;
      return { ...page, trace };
    } catch (e) {
      if (e instanceof HeliusError) {
        trace.push({ source: "helius_enhanced", result: traceResult(e.kind) });
        throw new ProviderUnavailableError("helius", e.kind, e.message, trace);
      }
      throw e;
    }
  }

  // ─── PRIMARY ──────────────────────────────────────────────────────────────

  async #primaryPage(req: PageRequest, token: string | null): Promise<Omit<HistoryPage, "trace">> {
    const limit = Math.max(1, Math.min(req.limit, this.#config.maxPrimaryLimit));
    const params: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: req.order,
      limit,
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "finalized",
      filters: { status: this.#config.status },
    };
    if (token) params.paginationToken = token;
    const calls = { n: 0 };
    const result = (await this.#rpc("helius_gtfa", "getTransactionsForAddress", [req.address, params], calls)) as { data?: GtfaItem[]; paginationToken?: string | null } | null;
    if (result !== null && typeof result === "object" && result.data !== undefined && !Array.isArray(result.data)) {
      throw new HeliusError("parse", "getTransactionsForAddress", "unexpected getTransactionsForAddress payload");
    }
    const data = result?.data ?? [];
    const all = data.map((d) => normalizeParsed({ slot: d.slot, blockTime: d.blockTime ?? null, transaction: d.transaction, meta: d.meta }, "helius-gtfa"));
    const failed = all.filter((t) => t.failed).length;
    const txs: HistoryTx[] = all.filter((t) => !t.failed);
    const next = result?.paginationToken && data.length > 0 ? encodeCursor({ kind: "gtfa", value: result.paginationToken }) : null;
    const filtered = this.#config.status === "succeeded";
    return {
      txs,
      nextCursor: next,
      provider: "helius",
      strategy: "helius_gtfa",
      calls: calls.n,
      missing: 0,
      stats: {
        signaturesRequested: limit,
        signaturesListed: data.length,
        transactionsFetched: data.length,
        transactionsFromCache: 0,
        transactionsSucceeded: txs.length,
        // With filters.status = "succeeded", failed ones are dropped server-side: their number is unknown.
        transactionsFailed: filtered ? null : failed,
        transactionsNormalized: txs.length,
        missing: 0,
      },
      ...(req.order === "asc" && !token ? { reachedStart: true, originStatus: "reached" as const } : {}),
    };
  }

  // ─── FALLBACK ─────────────────────────────────────────────────────────────

  async #fallbackPage(req: PageRequest, before: string | null, restarted: boolean): Promise<Omit<HistoryPage, "trace">> {
    const calls = { n: 0 };
    const limit = Math.max(1, Math.min(req.limit, 1000));
    const opts: Record<string, unknown> = { limit, commitment: "finalized" };
    if (before) opts.before = before;
    const sigs = (await this.#rpc("helius_signatures_enhanced", "getSignaturesForAddress", [req.address, opts], calls)) as SignatureInfo[];
    if (!Array.isArray(sigs)) throw new HeliusError("parse", "getSignaturesForAddress", "unexpected signatures payload");
    const d = await this.#decode(sigs, req, calls);
    const next = sigs.length === limit ? encodeCursor({ kind: "sig", value: sigs[sigs.length - 1].signature }) : null;
    return {
      txs: d.txs,
      nextCursor: next,
      provider: "helius",
      strategy: "helius_signatures_enhanced",
      calls: calls.n,
      missing: d.missing,
      stats: { ...d.stats, signaturesRequested: limit },
      ...(restarted ? { restarted: true, note: "cursor from getTransactionsForAddress: restarted from the newest transaction" } : {}),
    };
  }

  /** Oldest transactions: walk signature pages to the end (bounded), first page only. */
  async #fallbackOldest(req: PageRequest): Promise<Omit<HistoryPage, "trace">> {
    const calls = { n: 0 };
    const limit = Math.max(1, req.limit);
    const empty = (signaturesListed: number, originStatus: "budget_exhausted" | "unsupported", note: string): Omit<HistoryPage, "trace"> => ({
      txs: [],
      nextCursor: null,
      provider: "helius",
      strategy: "helius_signatures_enhanced",
      calls: calls.n,
      missing: 0,
      reachedStart: false,
      originStatus,
      note,
      stats: { signaturesRequested: limit, signaturesListed, transactionsFetched: 0, transactionsFromCache: 0, transactionsSucceeded: null, transactionsFailed: null, transactionsNormalized: 0, missing: 0 },
    });
    if (req.cursor) return empty(0, "unsupported", "oldest-first paging beyond the first page needs getTransactionsForAddress");
    const all: SignatureInfo[] = [];
    let before: string | undefined;
    let reached = false;
    for (let p = 0; p < this.#config.fallbackOldestSignaturePages; p++) {
      const opts: Record<string, unknown> = { limit: 1000, commitment: "finalized" };
      if (before) opts.before = before;
      const page = (await this.#rpc("helius_signatures_enhanced", "getSignaturesForAddress", [req.address, opts], calls)) as SignatureInfo[];
      if (!Array.isArray(page)) throw new HeliusError("parse", "getSignaturesForAddress", "unexpected signatures payload");
      all.push(...page);
      if (page.length < 1000) {
        reached = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    if (!reached) return empty(all.length, "budget_exhausted", `start of history beyond ${all.length} signatures`);
    const oldest = all.slice(-limit).reverse();
    const d = await this.#decode(oldest, req, calls);
    return {
      txs: d.txs,
      nextCursor: null,
      provider: "helius",
      strategy: "helius_signatures_enhanced",
      calls: calls.n,
      missing: d.missing,
      reachedStart: true,
      originStatus: "reached",
      stats: { ...d.stats, signaturesRequested: limit },
    };
  }

  /** Enhanced decoding of listed signatures, keeping their order and skipping cached and failed ones. */
  async #decode(sigs: SignatureInfo[], req: PageRequest, calls: { n: number }): Promise<{ txs: HistoryTx[]; missing: number; stats: PageStats }> {
    const wanted = sigs.filter((s) => this.#config.status === "any" || !s.err);
    const failed = sigs.filter((s) => !!s.err).length;
    const found = new Map<string, HistoryTx>();
    const toFetch: string[] = [];
    let fromCache = 0;
    for (const s of wanted) {
      const hit = req.cached?.(s.signature);
      if (hit) {
        found.set(s.signature, hit);
        fromCache++;
      } else toFetch.push(s.signature);
    }
    let fetched = 0;
    for (let i = 0; i < toFetch.length; i += this.#config.enhancedBatch) {
      const batch = toFetch.slice(i, i + this.#config.enhancedBatch);
      const res = (await this.#post("helius_signatures_enhanced", "enhancedTransactions", this.#config.enhancedUrl, { transactions: batch }, calls)) as EnhancedTransaction[] | null;
      if (res !== null && !Array.isArray(res)) throw new HeliusError("parse", "enhancedTransactions", "unexpected enhanced payload");
      for (const e of res ?? []) {
        if (e && e.signature) {
          found.set(e.signature, normalizeEnhanced(e));
          fetched++;
        }
      }
    }
    const txs: HistoryTx[] = [];
    let missing = 0;
    for (const s of wanted) {
      const tx = found.get(s.signature);
      if (!tx || tx.failed) {
        missing += tx ? 0 : 1;
        continue;
      }
      if (tx.slot === null && s.slot !== undefined) tx.slot = s.slot;
      if (tx.time === null && s.blockTime) tx.time = s.blockTime * 1000;
      txs.push(tx);
    }
    return {
      txs,
      missing,
      stats: {
        signaturesRequested: sigs.length,
        signaturesListed: sigs.length,
        transactionsFetched: fetched,
        transactionsFromCache: fromCache,
        transactionsSucceeded: sigs.length - failed,
        transactionsFailed: failed,
        transactionsNormalized: txs.length,
        missing,
      },
    };
  }

  // ─── transport ────────────────────────────────────────────────────────────

  #rpc(strategy: HistoryStrategy, method: string, params: unknown[], calls: { n: number }): Promise<unknown> {
    return this.#post(strategy, method, this.#config.rpcUrl, { jsonrpc: "2.0", id: this.#nextId++, method, params }, calls, true);
  }

  #url(base: string): string {
    const u = new URL(base);
    u.searchParams.set("api-key", this.#apiKey);
    return u.toString();
  }

  #redact(message: string): string {
    return message.split(this.#apiKey).join("[redacted]").replace(/api-key=[^&\s"']+/gi, "api-key=[redacted]");
  }

  #log(strategy: HistoryStrategy, method: string, attempt: number, status: number | null, outcome: HistoryLogEntry["outcome"], note?: string): void {
    this.#onRequest?.({ provider: "helius", strategy, method, attempt, status, outcome, ...(note ? { note: this.#redact(note) } : {}) });
  }

  async #post(strategy: HistoryStrategy, method: string, base: string, body: unknown, calls: { n: number }, jsonRpc = false): Promise<unknown> {
    const max = this.#config.maxRetries;
    let last: HeliusError | null = null;
    for (let attempt = 1; attempt <= max + 1; attempt++) {
      await this.#limiter.acquire();
      const canRetry = attempt <= max;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
      let status: number;
      let text: string;
      calls.n++;
      try {
        const res = await this.#fetch(this.#url(base), { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        status = res.status;
        text = await res.text();
      } catch (err) {
        const timedOut = controller.signal.aborted;
        last = new HeliusError(timedOut ? "timeout" : "network", method, this.#redact(timedOut ? `Helius timeout after ${this.#config.timeoutMs} ms` : `Helius network error: ${err instanceof Error ? err.message : String(err)}`));
        this.#log(strategy, method, attempt, null, canRetry ? "retry" : "error", last.message);
        if (!canRetry) break;
        await this.#sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }

      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const rpcErr = jsonRpc ? ((parsed as { error?: { code?: number; message?: string } } | undefined)?.error ?? null) : null;
      const code = rpcErr?.code ?? null;
      const detail = this.#redact(rpcErr?.message ?? (typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 160)));

      if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
        last = new HeliusError("rate_limit", method, `Helius rate limited (${status}${code !== null ? `, code ${code}` : ""})`, 429);
        this.#log(strategy, method, attempt, status, canRetry ? "retry" : "error", last.message);
        if (!canRetry) break;
        const wait = backoff(attempt + 1);
        this.#limiter.pauseFor(wait);
        await this.#sleep(wait);
        continue;
      }
      if (status === 401) {
        last = new HeliusError("auth", method, `Helius rejected the API key (401)`, 401);
      } else if (status === 403) {
        last = new HeliusError("forbidden", method, `Helius 403: ${detail}`, 403);
      } else if (status === 404 || (code !== null && UNAVAILABLE_CODES.has(code)) || (rpcErr && PLAN_MESSAGE.test(rpcErr.message ?? ""))) {
        last = new HeliusError("unavailable", method, `Helius ${method} unavailable: ${detail}`, status);
      } else if (status >= 500) {
        last = new HeliusError("http", method, `Helius HTTP ${status}`, status);
        this.#log(strategy, method, attempt, status, canRetry ? "retry" : "error", last.message);
        if (!canRetry) break;
        await this.#sleep(backoff(attempt));
        continue;
      } else if (status >= 400) {
        last = new HeliusError("http", method, `Helius HTTP ${status}: ${detail}`, status);
      } else if (parsed === undefined) {
        last = new HeliusError("parse", method, `Invalid JSON from Helius`, status);
      } else if (rpcErr) {
        last = new HeliusError("rpc", method, `Helius RPC error ${code}: ${detail}`, status);
      } else {
        this.#log(strategy, method, attempt, status, "ok");
        return jsonRpc ? (parsed as { result?: unknown }).result : parsed;
      }
      this.#log(strategy, method, attempt, status, "error", last.message);
      break;
    }
    throw last ?? new HeliusError("network", method, "Unknown Helius failure");
  }
}

function backoff(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 10_000);
}
