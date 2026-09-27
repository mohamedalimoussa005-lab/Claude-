/**
 * SERVER-SIDE ONLY. Solana RPC for the Node backend and scripts: an
 * authenticated RPC (Helius, from HELIUS_API_KEY) when available, the public
 * RPC as fallback. Never import this from src/ui.
 *
 * The authenticated URL (with its key) exists only inside the closure of
 * `authenticatedFetch`: the SolanaRpc it feeds is labelled "authenticated_rpc",
 * and everything that comes back (bodies, errors) is redacted. Diagnostics
 * only ever say "authenticated_rpc" / "public_rpc".
 *
 * Algorithms (step 3 / step 4) are unchanged: only the transport changes.
 */

import { ONCHAIN_CONFIG } from "../onchain/config.ts";
import type { OnchainConfig } from "../onchain/config.ts";
import { SolanaRpc } from "../onchain/rpc.ts";
import type { RpcLogEntry } from "../onchain/rpc.ts";
import type { OnchainRpc } from "../onchain/collect.ts";
import type { Sleep } from "../api/rateLimiter.ts";
import { CircuitOpenError, classifyFailure } from "../history/failure.ts";
import type { FailureKind } from "../history/failure.ts";
import { assertServerSide } from "../history/provider.ts";
import { readHeliusKey } from "../history/server/heliusEnv.ts";

export type RpcProviderLabel = "authenticated_rpc" | "public_rpc";

const AUTHENTICATED_BASE = "https://mainnet.helius-rpc.com/";

/** A fetch bound to the authenticated endpoint. The keyed URL never leaves this closure; responses and errors are redacted. */
export function authenticatedFetch(apiKey: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis), base = AUTHENTICATED_BASE): typeof fetch {
  assertServerSide("authenticatedFetch");
  if (!apiKey) throw new Error("authenticated RPC: missing server-side HELIUS_API_KEY");
  const target = new URL(base);
  target.searchParams.set("api-key", apiKey);
  const endpoint = target.toString();
  const host = target.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endpointPattern = new RegExp(`(?:https?:)?//${host}[^\\s"'<>]*`, "gi");
  // The endpoint itself is replaced by its label; then any stray key or key parameter.
  const redact = (s: string) =>
    s.replace(endpointPattern, "[authenticated_rpc]").split(apiKey).join("[redacted]").replace(/api-key=[^&\s"'<>]+/gi, "api-key=[redacted]");
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, init);
    } catch (e) {
      // Never forward the original error: its message may contain the URL.
      const name = e instanceof Error && e.name === "AbortError" ? "AbortError" : "network error";
      throw new Error(`authenticated_rpc unreachable (${name})`);
    }
    const text = await res.text();
    return new Response(redact(text), { status: res.status });
  }) as typeof fetch;
}

type Rpc = OnchainRpc;
interface Provider {
  label: RpcProviderLabel;
  rpc: Rpc;
  state: "healthy" | "unavailable_for_run";
  openedBy: FailureKind | null;
  ok: number;
  failed: number;
}

export interface RpcProviderDiagnostics {
  label: RpcProviderLabel;
  state: "healthy" | "unavailable_for_run";
  openedBy: FailureKind | null;
  ok: number;
  failed: number;
}

/** A provider that answers 401/403 or runs out of quota is unusable for the rest of the run. */
function disables(e: unknown): FailureKind | null {
  const kind = classifyFailure(e);
  if (kind === "quota_exhausted") return kind;
  const code = (e as { code?: number | null }).code;
  if (code === 401 || code === 403) return "rpc_error";
  return null;
}

/**
 * Authenticated RPC first, public RPC as fallback — at most one fallback per
 * operation, a circuit breaker per provider (quota / 401 / 403 → unavailable
 * for the run), no retry loop beyond each client's own retries.
 */
export class FailoverSolanaRpc implements Rpc {
  /** A label, never an endpoint. */
  readonly url: string;
  private readonly providers: Provider[];
  fallbacks = 0;
  lastProvider: RpcProviderLabel | null = null;

  constructor(providers: { label: RpcProviderLabel; rpc: Rpc }[]) {
    if (!providers.length) throw new Error("no RPC provider");
    this.providers = providers.map((p) => ({ ...p, state: "healthy", openedBy: null, ok: 0, failed: 0 }));
    this.url = providers.map((p) => p.label).join("+");
  }

  getParsedAccount(address: string) {
    return this.route("getAccountInfo", (r) => r.getParsedAccount(address));
  }
  getTokenAccountsForMint(programId: string, mint: string) {
    return this.route("getProgramAccounts", (r) => r.getTokenAccountsForMint(programId, mint));
  }
  getMultipleAccounts(addresses: string[]) {
    return this.route("getMultipleAccounts", (r) => r.getMultipleAccounts(addresses));
  }
  getSignatures(address: string, limit: number, before?: string) {
    return this.route("getSignaturesForAddress", (r) => r.getSignatures(address, limit, before));
  }
  getTransaction(signature: string) {
    return this.route("getTransaction", (r) => r.getTransaction(signature));
  }
  getBalanceLamports(address: string) {
    return this.route("getBalance", (r) => r.getBalanceLamports(address));
  }

  diagnostics(): { providers: RpcProviderDiagnostics[]; fallbacks: number; lastProvider: RpcProviderLabel | null } {
    return { providers: this.providers.map(({ label, state, openedBy, ok, failed }) => ({ label, state, openedBy, ok, failed })), fallbacks: this.fallbacks, lastProvider: this.lastProvider };
  }

  toJSON() {
    return { url: this.url, ...this.diagnostics() };
  }

  private async route<T>(method: string, fn: (r: Rpc) => Promise<T>): Promise<T> {
    const live = this.providers.filter((p) => p.state === "healthy").slice(0, 2);
    if (!live.length) throw new CircuitOpenError(method, this.providers[this.providers.length - 1].openedBy ?? "quota_exhausted");
    let last: unknown;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      try {
        const v = await fn(p.rpc);
        p.ok++;
        this.lastProvider = p.label;
        return v;
      } catch (e) {
        p.failed++;
        last = e;
        const off = disables(e);
        if (off) {
          p.state = "unavailable_for_run";
          p.openedBy = off;
        }
        if (i + 1 < live.length) this.fallbacks++;
      }
    }
    throw last;
  }
}

/**
 * The backend's Solana RPC. HELIUS_API_KEY set → authenticated_rpc then
 * public_rpc; unset → public_rpc only (as before). SOLANA_RPC_URL may point
 * the public side to a custom endpoint, but never carry a key.
 */
export function createServerSolanaRpc(o: {
  env: Record<string, string | undefined>;
  config?: OnchainConfig;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  onRequest?: (e: RpcLogEntry & { provider: RpcProviderLabel }) => void;
}): { rpc: FailoverSolanaRpc; authenticated: boolean; providers: RpcProviderLabel[] } {
  assertServerSide("createServerSolanaRpc");
  const config = o.config ?? ONCHAIN_CONFIG;
  const custom = o.env.SOLANA_RPC_URL?.trim();
  if (custom && /api[-_]?key|token=|secret/i.test(custom)) {
    throw new Error("SOLANA_RPC_URL must not carry a key: set HELIUS_API_KEY on the server instead");
  }
  const key = readHeliusKey(o.env);
  const log = (provider: RpcProviderLabel) => (o.onRequest ? (e: RpcLogEntry) => o.onRequest!({ ...e, provider }) : undefined);
  const list: { label: RpcProviderLabel; rpc: Rpc }[] = [];
  if (key) list.push({ label: "authenticated_rpc", rpc: new SolanaRpc({ url: "authenticated_rpc", config, fetchImpl: authenticatedFetch(key, o.fetchImpl), sleep: o.sleep, onRequest: log("authenticated_rpc") }) });
  list.push({ label: "public_rpc", rpc: new SolanaRpc({ url: custom || config.rpc.url, config, fetchImpl: o.fetchImpl, sleep: o.sleep, onRequest: log("public_rpc") }) });
  return { rpc: new FailoverSolanaRpc(list), authenticated: key !== null, providers: list.map((p) => p.label) };
}
