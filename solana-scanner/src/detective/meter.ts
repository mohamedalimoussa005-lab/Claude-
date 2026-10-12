/**
 * Budgeted read-only RPC: counts every call, stops at the call or time budget (BudgetError), and never exposes a
 * write method. The wrapped client is the scanner's SolanaRpc (rate limits, retries and caching stay as they are).
 */

import type { SolanaRpc } from "../onchain/rpc.ts";
import type { RpcLogEntry } from "../onchain/rpc.ts";
import type { BudgetReport, ModeName } from "./types.ts";

export class BudgetError extends Error {
  readonly kind: "calls" | "time";
  constructor(kind: "calls" | "time", message: string) {
    super(message);
    this.name = "BudgetError";
    this.kind = kind;
  }
}

export type ReadRpc = Pick<SolanaRpc, "url" | "getParsedAccount" | "getTokenAccountsForMint" | "getMultipleAccounts" | "getSignatures" | "getTransaction" | "getBalanceLamports" | "call">;

export class Meter {
  calls = 0;
  readonly byMethod: Record<string, number> = {};
  httpAttempts = 0;
  retries = 0;
  httpSeen = false;
  readonly limitsReached: string[] = [];
  readonly mode: ModeName;
  readonly maxCalls: number;
  readonly maxMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  constructor(mode: ModeName, maxCalls: number, maxMs: number, now: () => number = Date.now) {
    this.mode = mode;
    this.maxCalls = maxCalls;
    this.maxMs = maxMs;
    this.now = now;
    this.startedAt = now();
  }
  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }
  /** Called by the budgeted client before every call. */
  charge(method: string): void {
    if (this.elapsedMs > this.maxMs) {
      this.limit(`budget de temps atteint (${Math.round(this.maxMs / 1000)} s)`);
      throw new BudgetError("time", `budget de temps atteint (${Math.round(this.maxMs / 1000)} s)`);
    }
    if (this.calls >= this.maxCalls) {
      this.limit(`budget d'appels RPC atteint (${this.maxCalls})`);
      throw new BudgetError("calls", `budget d'appels RPC atteint (${this.maxCalls})`);
    }
    this.calls++;
    this.byMethod[method] = (this.byMethod[method] ?? 0) + 1;
  }
  /** Hook for SolanaRpc.onRequest: counts real HTTP attempts and retries. */
  onRequest = (e: RpcLogEntry): void => {
    if (e.outcome === "cache") return;
    this.httpSeen = true;
    this.httpAttempts++;
    if (e.outcome === "retry") this.retries++;
  };
  limit(text: string): void {
    if (!this.limitsReached.includes(text)) this.limitsReached.push(text);
  }
  get exhausted(): boolean {
    return this.calls >= this.maxCalls || this.elapsedMs > this.maxMs;
  }
  report(): BudgetReport {
    return {
      mode: this.mode,
      maxCalls: this.maxCalls,
      maxMs: this.maxMs,
      calls: this.calls,
      byMethod: { ...this.byMethod },
      httpAttempts: this.httpSeen ? this.httpAttempts : null,
      retries: this.httpSeen ? this.retries : null,
      elapsedMs: this.elapsedMs,
      limitsReached: [...this.limitsReached],
    };
  }
}

/** Wraps a read-only RPC with the meter. Only read methods exist on the wrapper. */
export function budgeted(rpc: ReadRpc, meter: Meter): ReadRpc {
  const w = (method: string) => meter.charge(method);
  return {
    url: rpc.url,
    getParsedAccount: async (a) => (w("getAccountInfo"), rpc.getParsedAccount(a)),
    getTokenAccountsForMint: async (p, m) => (w("getProgramAccounts"), rpc.getTokenAccountsForMint(p, m)),
    getMultipleAccounts: async (addrs) => (w("getMultipleAccounts"), rpc.getMultipleAccounts(addrs)),
    getSignatures: async (a, l, b) => (w("getSignaturesForAddress"), rpc.getSignatures(a, l, b)),
    getTransaction: async (s) => (w("getTransaction"), rpc.getTransaction(s)),
    getBalanceLamports: async (a) => (w("getBalance"), rpc.getBalanceLamports(a)),
    call: async (method, params) => {
      const READ = new Set(["getEpochInfo", "getProgramAccounts", "getBlockTime", "getTokenSupply", "getAccountInfo", "getMultipleAccounts"]);
      if (!READ.has(method)) throw new Error(`méthode RPC non autorisée en lecture seule: ${method}`);
      w(method);
      return rpc.call(method, params);
    },
  } as ReadRpc;
}
