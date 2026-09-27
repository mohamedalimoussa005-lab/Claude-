/** Shared provider plumbing: errors and the server-side guard. */

import type { HistoryProviderName, TraceResult, TraceStep } from "./types.ts";

/** Maps an internal error kind (Helius or RPC client) to a fixed trace code. */
export function traceResult(kind: string | undefined): TraceResult {
  switch (kind) {
    case "auth":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "rate_limit":
      return "rate_limited";
    case "unavailable":
      return "method_unavailable";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "parse":
      return "invalid_response";
    default:
      return "unknown";
  }
}

/** A provider can't serve this request at all; the service tries the next one. */
export class ProviderUnavailableError extends Error {
  readonly provider: HistoryProviderName;
  readonly kind: string;
  readonly trace: TraceStep[];
  constructor(provider: HistoryProviderName, kind: string, message: string, trace: TraceStep[] = []) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.provider = provider;
    this.kind = kind;
    this.trace = trace;
  }
}

/** Why one provider could not serve a request. `kind` is safe to expose; `message` is for server logs. */
export interface ProviderFailure {
  provider: HistoryProviderName;
  kind: string;
  message: string;
  /** Non-sensitive steps taken before failing. */
  trace: TraceStep[];
}

/** Every provider failed for a request. */
export class HistoryUnavailableError extends Error {
  readonly failures: ProviderFailure[];
  constructor(failures: ProviderFailure[]) {
    super(`No history provider could serve the request: ${failures.map((f) => `${f.provider}: ${f.message}`).join(" | ") || "no provider configured"}`);
    this.name = "HistoryUnavailableError";
    this.failures = failures;
  }
}

/** Refuses to run where a secret would be exposed (a browser bundle). */
export function assertServerSide(what: string): void {
  const g = globalThis as { window?: unknown; document?: unknown };
  if (typeof g.window !== "undefined" || typeof g.document !== "undefined") {
    throw new Error(`${what} is server-side only: it must never run in the browser`);
  }
}
