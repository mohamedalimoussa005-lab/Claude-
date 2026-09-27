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

export type Mode = "quick" | "deep";

export type ParsedQuery = { ok: true; address: string; mode: Mode } | { ok: false; error: "invalid_address" | "invalid_mode" | "unknown_parameter" };

const ALLOWED = new Set(["address", "mode"]);

export function parseQuery(params: URLSearchParams): ParsedQuery {
  for (const k of params.keys()) if (!ALLOWED.has(k)) return { ok: false, error: "unknown_parameter" };
  const addresses = params.getAll("address");
  const modes = params.getAll("mode");
  if (addresses.length !== 1 || !isSolanaAddress(addresses[0])) return { ok: false, error: "invalid_address" };
  if (modes.length !== 1 || (modes[0] !== "quick" && modes[0] !== "deep")) return { ok: false, error: "invalid_mode" };
  return { ok: true, address: addresses[0], mode: modes[0] };
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
