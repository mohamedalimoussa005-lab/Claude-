/**
 * Read-only Solana JSON-RPC client.
 *
 * - Only read methods are exposed: no signing, no sendTransaction, no wallet.
 * - Client-side sliding-window rate limit (the public endpoint is shared).
 * - Retries HTTP 429 / JSON-RPC rate-limit errors, 5xx, network errors and
 *   timeouts with backoff; other JSON-RPC errors fail immediately.
 * - TTL cache keyed by method + params, with in-flight de-duplication, so
 *   re-opening a token or re-running a scan doesn't repeat calls.
 */

import { RateLimiter, realSleep } from "../api/rateLimiter.ts";
import type { Sleep } from "../api/rateLimiter.ts";
import { ONCHAIN_CONFIG } from "./config.ts";
import type { OnchainConfig } from "./config.ts";

export type RpcErrorKind = "http" | "rate_limit" | "network" | "timeout" | "rpc" | "parse";

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly method: string;
  readonly code: number | null;
  constructor(kind: RpcErrorKind, method: string, message: string, code: number | null = null) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.method = method;
    this.code = code;
  }
}

export interface RpcLogEntry {
  method: string;
  attempt: number;
  durationMs: number;
  outcome: "ok" | "cache" | "retry" | "error";
  note?: string;
}

/** Minimal TTL cache. Values must be JSON-safe. */
export class TtlCache {
  private readonly store = new Map<string, { expires: number; value: unknown }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
  get size(): number {
    return this.store.size;
  }
}

export interface SolanaRpcOptions {
  url?: string;
  config?: OnchainConfig;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  cache?: TtlCache;
  onRequest?: (e: RpcLogEntry) => void;
}

/** JSON-RPC error codes public endpoints use for rate limiting. */
const RATE_LIMIT_CODES = new Set([429, -32005, -32429]);

// ─── response shapes (only the fields we read) ─────────────────────────────

export interface ParsedMintAccount {
  owner: string;
  data: { parsed?: { type?: string; info?: Record<string, unknown> } } | [string, string];
}

export interface RawAccount {
  owner: string;
  lamports: number;
  executable: boolean;
  data: [string, string];
}

export interface SignatureInfo {
  signature: string;
  slot?: number;
  blockTime: number | null;
  err: unknown;
}

export interface ParsedTransaction {
  slot?: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
      instructions: ParsedInstruction[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[];
  } | null;
}

export interface ParsedInstruction {
  programId: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export class SolanaRpc {
  readonly url: string;
  private readonly config: OnchainConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly limiter: RateLimiter;
  private readonly methodLimiters = new Map<string, RateLimiter>();
  readonly cache: TtlCache;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly onRequest?: (e: RpcLogEntry) => void;
  private nextId = 1;

  constructor(options: SolanaRpcOptions = {}) {
    this.config = options.config ?? ONCHAIN_CONFIG;
    this.url = options.url ?? this.config.rpc.url;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? realSleep;
    this.limiter = new RateLimiter(this.config.rpc.maxRequests, this.config.rpc.windowMs, Date.now, this.sleep);
    for (const [method, max] of Object.entries(this.config.rpc.perMethod)) {
      this.methodLimiters.set(method, new RateLimiter(max, this.config.rpc.windowMs, Date.now, this.sleep));
    }
    this.cache = options.cache ?? new TtlCache();
    this.onRequest = options.onRequest;
  }

  // ─── read methods ─────────────────────────────────────────────────────────

  getParsedAccount(address: string): Promise<ParsedMintAccount | null> {
    return this.cached("getAccountInfo", [address, { encoding: "jsonParsed" }], this.config.cacheTtlMs.mint, (r) => {
      return ((r as { value: ParsedMintAccount | null }).value ?? null) as ParsedMintAccount | null;
    });
  }

  /** Every token account of a mint, sliced to owner (32 bytes) + amount (u64). */
  getTokenAccountsForMint(programId: string, mint: string): Promise<{ pubkey: string; data: string }[]> {
    return this.cached(
      "getProgramAccounts",
      [programId, { encoding: "base64", dataSlice: { offset: 32, length: 40 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }],
      this.config.cacheTtlMs.holders,
      (r) => (r as { pubkey: string; account: { data: [string, string] } }[]).map((a) => ({ pubkey: a.pubkey, data: a.account.data[0] })),
    );
  }

  async getMultipleAccounts(addresses: string[]): Promise<(RawAccount | null)[]> {
    const out: (RawAccount | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const batch = addresses.slice(i, i + 100);
      const res = await this.cached("getMultipleAccounts", [batch, { encoding: "base64" }], this.config.cacheTtlMs.accounts, (r) => {
        return (r as { value: (RawAccount | null)[] }).value;
      });
      out.push(...res);
    }
    return out;
  }

  getSignatures(address: string, limit: number, before?: string): Promise<SignatureInfo[]> {
    const opts: Record<string, unknown> = { limit };
    if (before) opts.before = before;
    return this.cached("getSignaturesForAddress", [address, opts], this.config.cacheTtlMs.signatures, (r) => r as SignatureInfo[]);
  }

  getTransaction(signature: string): Promise<ParsedTransaction | null> {
    return this.cached(
      "getTransaction",
      [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }],
      this.config.cacheTtlMs.transaction,
      (r) => (r as ParsedTransaction | null) ?? null,
    );
  }

  getBalanceLamports(address: string): Promise<number> {
    return this.cached("getBalance", [address], this.config.cacheTtlMs.balance, (r) => (r as { value: number }).value);
  }

  // ─── transport ────────────────────────────────────────────────────────────

  private async cached<T>(method: string, params: unknown[], ttlMs: number, map: (result: unknown) => T): Promise<T> {
    const key = `${method}:${JSON.stringify(params)}`;
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) {
      this.onRequest?.({ method, attempt: 0, durationMs: 0, outcome: "cache" });
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = this.call(method, params)
      .then((r) => {
        const v = map(r);
        this.cache.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async call(method: string, params: unknown[]): Promise<unknown> {
    const max = this.config.rpc.maxRetries;
    let last: RpcError | null = null;
    for (let attempt = 1; attempt <= max + 1; attempt++) {
      const methodLimiter = this.methodLimiters.get(method);
      if (methodLimiter) await methodLimiter.acquire();
      await this.limiter.acquire();
      const started = Date.now();
      const canRetry = attempt <= max;
      const log = (outcome: RpcLogEntry["outcome"], note?: string) =>
        this.onRequest?.({ method, attempt, durationMs: Date.now() - started, outcome, note });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.rpc.timeoutMs);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        });
        text = await res.text();
      } catch (err) {
        const timedOut = controller.signal.aborted;
        last = new RpcError(timedOut ? "timeout" : "network", method, timedOut ? `RPC timeout after ${this.config.rpc.timeoutMs} ms` : `RPC network error: ${err instanceof Error ? err.message : String(err)}`);
        log(canRetry ? "retry" : "error", last.message);
        if (!canRetry) break;
        await this.sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }

      let body: { result?: unknown; error?: { code?: number; message?: string } } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const rpcCode = body?.error?.code ?? null;

      if (res.status === 429 || (rpcCode !== null && RATE_LIMIT_CODES.has(rpcCode))) {
        const wait = backoff(attempt + 1);
        (methodLimiter ?? this.limiter).pauseFor(wait);
        last = new RpcError("rate_limit", method, `RPC rate limited (${res.status}${rpcCode !== null ? `, code ${rpcCode}` : ""}): ${body?.error?.message ?? ""}`.trim(), rpcCode ?? 429);
        log(canRetry ? "retry" : "error", last.message);
        if (!canRetry) break;
        continue;
      }
      if (res.status >= 500) {
        last = new RpcError("http", method, `RPC HTTP ${res.status}`, res.status);
        log(canRetry ? "retry" : "error", last.message);
        if (!canRetry) break;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (!res.ok && !body) {
        last = new RpcError("http", method, `RPC HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
        log("error", last.message);
        break;
      }
      if (!body) {
        last = new RpcError("parse", method, `Invalid JSON from RPC: ${text.slice(0, 120)}`);
        log("error", last.message);
        break;
      }
      if (body.error) {
        last = new RpcError("rpc", method, `RPC error ${rpcCode}: ${body.error.message ?? "unknown"}`, rpcCode);
        log("error", last.message);
        break;
      }
      log("ok");
      return body.result;
    }
    throw last ?? new RpcError("network", method, "Unknown RPC failure");
  }
}

function backoff(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 10_000);
}
