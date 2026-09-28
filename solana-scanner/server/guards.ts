/**
 * Request guards for the wallet history API: parameter validation, per-client
 * rate limiting, a concurrency cap, a timeout and the DEEP access check.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

/** A Solana address: base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) return false;
    n = n * 58n + BigInt(v);
  }
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return bytes + zeros === 32;
}

export type Mode = "quick" | "deep" | "completion";

export type ParsedQuery =
  | { ok: true; address: string; mode: "quick" | "deep" }
  | { ok: true; address: string; mode: "completion"; cursor: string; pages: number }
  | { ok: false; error: "invalid_address" | "invalid_mode" | "unknown_parameter" | "invalid_cursor" | "invalid_pages" };

const ALLOWED = new Set(["address", "mode"]);
const COMPLETION_ALLOWED = new Set(["address", "mode", "cursor", "pages"]);
const B58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const GTFA_POSITION = /^\d{1,20}:\d{1,10}$/;

/**
 * A page cursor produced by this server: "sig:<base58 signature>" or
 * "gtfa:<slot>:<position>". Anything else is refused (no free-form input
 * reaches a provider).
 */
export function isHistoryCursor(s: string): boolean {
  if (s.length > 120) return false;
  if (s.startsWith("sig:")) return B58_SIG.test(s.slice(4));
  if (s.startsWith("gtfa:")) return GTFA_POSITION.test(s.slice(5));
  return false;
}

/**
 * quick: address + mode. deep: address + mode (access checked separately).
 * completion (QUICK completion from the browser): address + mode + cursor,
 * optional pages in [1, maxCompletionPages]; every other budget is server-side.
 */
export function parseQuery(params: URLSearchParams, o: { maxCompletionPages: number } = { maxCompletionPages: 2 }): ParsedQuery {
  const modes = params.getAll("mode");
  const mode = modes.length === 1 ? modes[0] : null;
  const allowed = mode === "completion" ? COMPLETION_ALLOWED : ALLOWED;
  for (const k of params.keys()) if (!allowed.has(k)) return { ok: false, error: "unknown_parameter" };
  const addresses = params.getAll("address");
  if (addresses.length !== 1 || !isSolanaAddress(addresses[0])) return { ok: false, error: "invalid_address" };
  if (mode !== "quick" && mode !== "deep" && mode !== "completion") return { ok: false, error: "invalid_mode" };
  if (mode !== "completion") return { ok: true, address: addresses[0], mode };
  const cursors = params.getAll("cursor");
  if (cursors.length !== 1 || !isHistoryCursor(cursors[0])) return { ok: false, error: "invalid_cursor" };
  const pagesRaw = params.getAll("pages");
  if (pagesRaw.length > 1) return { ok: false, error: "invalid_pages" };
  const pages = pagesRaw.length ? Number(pagesRaw[0]) : o.maxCompletionPages;
  if (!/^\d+$/.test(pagesRaw[0] ?? "1") || !Number.isInteger(pages) || pages < 1 || pages > o.maxCompletionPages) return { ok: false, error: "invalid_pages" };
  return { ok: true, address: addresses[0], mode, cursor: cursors[0], pages };
}

/** Fixed-window counters per client and mode. */
export class WindowRateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(windowMs: number, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }
  /** Seconds to wait when refused, 0 when allowed. */
  take(key: string, max: number): number {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      h = { start: t, count: 0 };
      this.hits.set(key, h);
    }
    if (h.count >= max) return Math.max(1, Math.ceil((h.start + this.windowMs - t) / 1000));
    h.count++;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t - v.start >= this.windowMs) this.hits.delete(k);
    return 0;
  }
}

/** Non-queuing concurrency cap. */
export class ConcurrencyGate {
  private active = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  tryEnter(): boolean {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }
  leave(): void {
    this.active = Math.max(0, this.active - 1);
  }
  get running(): number {
    return this.active;
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopback(remote: string | undefined): boolean {
  return !!remote && LOOPBACK.has(remote);
}

/** Host header without port, when it is one of the allowed local hosts. */
export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return allowed.includes(name.toLowerCase());
}

/** Constant-time comparison of a bearer token against the configured one. */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
