/**
 * Minimal client for the public DEX Screener API
 * (https://docs.dexscreener.com/api/reference).
 *
 * Documented rate limits:
 *   - 60 req/min  : /token-profiles/*, /token-boosts/*, /community-takeovers/*, /orders/*
 *   - 300 req/min : /latest/dex/pairs/*, /latest/dex/search, /token-pairs/*, /tokens/*
 *
 * Each group gets its own limiter, set slightly below the documented limit.
 * HTTP 429 and 5xx responses are retried with backoff (honouring Retry-After).
 *
 * Responses are returned as `unknown`: validation and normalisation happen in
 * src/domain/normalize.ts so a schema change never crashes the client.
 */

import { RateLimiter, realSleep } from "./rateLimiter.ts";
import type { Sleep } from "./rateLimiter.ts";

export const DEXSCREENER_BASE_URL = "https://api.dexscreener.com";

/** Max addresses accepted by /tokens/v1 and /latest/dex/pairs in one call. */
export const MAX_ADDRESSES_PER_CALL = 30;

export type RateGroup = "slow" | "fast";

export const RATE_LIMITS: Record<RateGroup, { documentedPerMinute: number; appliedPerMinute: number }> = {
  slow: { documentedPerMinute: 60, appliedPerMinute: 55 },
  fast: { documentedPerMinute: 300, appliedPerMinute: 280 },
};

export type ApiErrorKind = "http" | "rate_limit" | "network" | "timeout" | "parse";

export class DexScreenerError extends Error {
  readonly kind: ApiErrorKind;
  readonly endpoint: string;
  readonly status: number | null;
  readonly attempts: number;

  constructor(kind: ApiErrorKind, endpoint: string, message: string, status: number | null, attempts: number) {
    super(message);
    this.name = "DexScreenerError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = status;
    this.attempts = attempts;
  }
}

export interface RequestLogEntry {
  endpoint: string;
  group: RateGroup;
  attempt: number;
  status: number | null;
  durationMs: number;
  outcome: "ok" | "retry" | "error";
  note?: string;
}

export interface DexScreenerClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries after the first attempt, for 429 / 5xx / network / timeout. */
  maxRetries?: number;
  onRequest?: (entry: RequestLogEntry) => void;
  limiters?: Partial<Record<RateGroup, RateLimiter>>;
  sleep?: Sleep;
}

const MINUTE = 60_000;

export class DexScreenerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onRequest?: (entry: RequestLogEntry) => void;
  private readonly limiters: Record<RateGroup, RateLimiter>;
  private readonly sleep: Sleep;

  constructor(options: DexScreenerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEXSCREENER_BASE_URL).replace(/\/+$/, "");
    // Bound so browsers don't throw "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.onRequest = options.onRequest;
    this.sleep = options.sleep ?? realSleep;
    this.limiters = {
      slow: options.limiters?.slow ?? new RateLimiter(RATE_LIMITS.slow.appliedPerMinute, MINUTE),
      fast: options.limiters?.fast ?? new RateLimiter(RATE_LIMITS.fast.appliedPerMinute, MINUTE),
    };
  }

  // ---- 60 req/min endpoints -------------------------------------------------

  /** Latest token profiles (all chains). */
  getLatestTokenProfiles(): Promise<unknown> {
    return this.request("/token-profiles/latest/v1", "slow");
  }

  /** Latest boosted tokens (all chains). */
  getLatestBoostedTokens(): Promise<unknown> {
    return this.request("/token-boosts/latest/v1", "slow");
  }

  /** Tokens with the most active boosts (all chains). */
  getTopBoostedTokens(): Promise<unknown> {
    return this.request("/token-boosts/top/v1", "slow");
  }

  // ---- 300 req/min endpoints ------------------------------------------------

  /** Pairs for up to 30 token addresses. Response: Pair[]. */
  getPairsByTokenAddresses(chainId: string, tokenAddresses: string[]): Promise<unknown> {
    assertBatch(tokenAddresses);
    return this.request(`/tokens/v1/${enc(chainId)}/${tokenAddresses.map(enc).join(",")}`, "fast");
  }

  /** All pools of one token. Response: Pair[]. */
  getTokenPools(chainId: string, tokenAddress: string): Promise<unknown> {
    return this.request(`/token-pairs/v1/${enc(chainId)}/${enc(tokenAddress)}`, "fast");
  }

  /** One or more pairs by pair address. Response: { schemaVersion, pairs }. */
  getPairsByPairAddresses(chainId: string, pairAddresses: string[]): Promise<unknown> {
    assertBatch(pairAddresses);
    return this.request(`/latest/dex/pairs/${enc(chainId)}/${pairAddresses.map(enc).join(",")}`, "fast");
  }

  /** Free-text search. Response: { schemaVersion, pairs }. */
  searchPairs(query: string): Promise<unknown> {
    return this.request(`/latest/dex/search?q=${enc(query)}`, "fast");
  }

  // ---- transport ------------------------------------------------------------

  private async request(endpoint: string, group: RateGroup): Promise<unknown> {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError: DexScreenerError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      await this.limiters[group].acquire();
      const started = Date.now();
      const log = (status: number | null, outcome: RequestLogEntry["outcome"], note?: string) =>
        this.onRequest?.({ endpoint, group, attempt, status, durationMs: Date.now() - started, outcome, note });
      const canRetry = attempt <= this.maxRetries;

      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      } catch (err) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        lastError = new DexScreenerError(
          timedOut ? "timeout" : "network",
          endpoint,
          timedOut
            ? `Request timed out after ${this.timeoutMs} ms`
            : `Network error: ${errorMessage(err)} (offline, DNS, CORS or blocked host?)`,
          null,
          attempt,
        );
        log(null, canRetry ? "retry" : "error", lastError.message);
        if (!canRetry) break;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 429) {
        clearTimeout(timer);
        const waitMs = retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt);
        this.limiters[group].pauseFor(waitMs);
        lastError = new DexScreenerError(
          "rate_limit",
          endpoint,
          `Rate limited by DEX Screener (HTTP 429), waited ${Math.round(waitMs / 1000)} s`,
          429,
          attempt,
        );
        log(429, canRetry ? "retry" : "error", `retry after ${waitMs} ms`);
        if (!canRetry) break;
        continue; // the limiter enforces the pause
      }

      if (!response.ok) {
        const body = await safeText(response);
        clearTimeout(timer);
        lastError = new DexScreenerError(
          "http",
          endpoint,
          `HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
          response.status,
          attempt,
        );
        const retryable = response.status >= 500;
        log(response.status, retryable && canRetry ? "retry" : "error", lastError.message);
        if (!retryable || !canRetry) break;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        lastError = new DexScreenerError(
          timedOut ? "timeout" : "network",
          endpoint,
          timedOut ? `Response body timed out after ${this.timeoutMs} ms` : `Failed reading body: ${errorMessage(err)}`,
          response.status,
          attempt,
        );
        log(response.status, canRetry ? "retry" : "error", lastError.message);
        if (!canRetry) break;
        await this.sleep(backoffMs(attempt));
        continue;
      }
      clearTimeout(timer);

      try {
        const data: unknown = JSON.parse(text);
        log(response.status, "ok");
        return data;
      } catch {
        lastError = new DexScreenerError(
          "parse",
          endpoint,
          `Invalid JSON in response: ${text.slice(0, 120)}`,
          response.status,
          attempt,
        );
        log(response.status, "error", lastError.message);
        break;
      }
    }

    throw lastError ?? new DexScreenerError("network", endpoint, "Unknown request failure", null, 0);
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function assertBatch(addresses: string[]): void {
  if (addresses.length === 0) throw new Error("At least one address is required");
  if (addresses.length > MAX_ADDRESSES_PER_CALL) {
    throw new Error(`At most ${MAX_ADDRESSES_PER_CALL} addresses per call (got ${addresses.length})`);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 16_000);
}

/** Parses Retry-After as seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(date - now, 0), 120_000);
  return null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  return String(err);
}
