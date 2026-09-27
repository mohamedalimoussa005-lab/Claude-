/**
 * Structured provider / RPC failures (step 4.2b) and a per-run circuit
 * breaker. Business code works with `FailureKind` codes only: raw upstream
 * messages are used here to classify, never stored or shown.
 */

import type { SolanaRpc } from "../onchain/rpc.ts";
import { HistoryUnavailableError, ProviderUnavailableError } from "./provider.ts";

export type FailureKind = "quota_exhausted" | "rate_limited" | "timeout" | "network" | "method_unavailable" | "invalid_response" | "rpc_error" | "unknown";

/** Upstream wording of an exhausted quota (e.g. "You have used your data allowance"). */
const QUOTA_MESSAGE = /data allowance|quota (?:exceeded|exhausted)|credits? (?:exhausted|exceeded)|out of credits/i;

/** Maps an internal error kind (RPC client, Helius, history provider) to a FailureKind. */
export function failureKindFromString(kind: string | undefined): FailureKind {
  switch (kind) {
    case "quota_exhausted":
      return "quota_exhausted";
    case "rate_limit":
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "unavailable":
    case "method_unavailable":
      return "method_unavailable";
    case "parse":
    case "invalid_response":
      return "invalid_response";
    case "rpc":
    case "http":
    case "auth":
    case "forbidden":
    case "rpc_error":
      return "rpc_error";
    default:
      return "unknown";
  }
}

/** Skipped call: the RPC was declared unavailable for this run. */
export class CircuitOpenError extends Error {
  readonly kind: FailureKind;
  constructor(method: string, kind: FailureKind) {
    super(`${method} skipped: RPC unavailable for this run (${kind})`);
    this.name = "CircuitOpenError";
    this.kind = kind;
  }
}

export function classifyFailure(e: unknown): FailureKind {
  if (e instanceof CircuitOpenError) return e.kind;
  if (e instanceof HistoryUnavailableError) {
    const kinds = e.failures.map((f) => failureKindFromString(f.kind));
    if (!kinds.length) return "unknown";
    return kinds.every((k) => k === kinds[0]) ? kinds[0] : kinds[kinds.length - 1];
  }
  if (e instanceof ProviderUnavailableError) return failureKindFromString(e.kind);
  const x = (e ?? {}) as { kind?: string; code?: number | null; message?: string };
  if (x.code === 413 || QUOTA_MESSAGE.test(x.message ?? "")) return "quota_exhausted";
  if (x.kind === "rpc" && x.code === -32601) return "method_unavailable";
  return failureKindFromString(x.kind);
}

/** Every provider behind a history failure ran out of quota. */
export function allQuotaExhausted(e: unknown): boolean {
  if (e instanceof HistoryUnavailableError) return e.failures.length > 0 && e.failures.every((f) => failureKindFromString(f.kind) === "quota_exhausted");
  return classifyFailure(e) === "quota_exhausted";
}

export type GuardedRpcTarget = Pick<SolanaRpc, "url" | "getSignatures" | "getTransaction">;

/**
 * Per-run circuit breaker around the read-only RPC: healthy → (quota
 * exhausted) → unavailable for the run. Once open, calls are not sent at all
 * (they fail fast with CircuitOpenError), so a spent quota costs no more calls.
 * Transient failures (timeout, network, rate limit) leave it closed.
 */
export class RunRpcGuard implements GuardedRpcTarget {
  readonly url: string;
  private readonly inner: GuardedRpcTarget;
  state: "healthy" | "unavailable_for_run" = "healthy";
  openedBy: FailureKind | null = null;
  /** Calls not sent because the circuit was open. */
  skipped = 0;

  constructor(inner: GuardedRpcTarget) {
    this.inner = inner;
    this.url = inner.url;
  }

  getSignatures(address: string, limit: number, before?: string): ReturnType<SolanaRpc["getSignatures"]> {
    return this.call("getSignaturesForAddress", () => this.inner.getSignatures(address, limit, before));
  }

  getTransaction(signature: string): ReturnType<SolanaRpc["getTransaction"]> {
    return this.call("getTransaction", () => this.inner.getTransaction(signature));
  }

  private async call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    if (this.state === "unavailable_for_run") {
      this.skipped++;
      throw new CircuitOpenError(method, this.openedBy ?? "quota_exhausted");
    }
    try {
      return await fn();
    } catch (e) {
      if (classifyFailure(e) === "quota_exhausted") {
        this.state = "unavailable_for_run";
        this.openedBy = "quota_exhausted";
      }
      throw e;
    }
  }
}
