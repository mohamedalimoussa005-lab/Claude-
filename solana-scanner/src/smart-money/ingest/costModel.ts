/**
 * What a request costs and which requests the agent may send at all.
 *
 * Credit prices are the ones documented by Helius (helius.dev/docs/billing and
 * /docs/billing/rate-limits, read through the Helius MCP knowledge tool on
 * 2026-10-16). They are an ESTIMATE of what a request is billed, not a
 * measurement: the real account is the authority.
 *
 * Allow-list: only the read methods the history providers use, only on
 * Helius or the public Solana RPC (or one explicitly configured keyless
 * endpoint). Anything else is refused before it leaves the process, so no
 * paid or unknown API can be reached by accident.
 */

export const COSTS_DOCUMENTED_ON = "2026-10-16";

export const CREDIT_COST = {
  /** getSignaturesForAddress, getTransaction and other standard RPC reads. */
  standardRpc: 1,
  /** POST /v0/transactions (enhanced decoding, up to 100 signatures). */
  enhancedTransactions: 100,
  /** getTransactionsForAddress, full transactions: 10 credits per 100 returned (Developer plan or higher only). */
  gtfaPer100: 10,
} as const;

export const FREE_PLAN = {
  monthlyCredits: 1_000_000,
  rpcRequestsPerSecond: 10,
  enhancedRequestsPerSecond: 2,
} as const;

export const HELIUS_HOST = "mainnet.helius-rpc.com";
export const PUBLIC_RPC_HOST = "api.mainnet-beta.solana.com";

export type RequestKind = "gtfa" | "signatures" | "transaction" | "enhanced";

export interface RequestInfo {
  host: string;
  kind: RequestKind;
  /** Estimated Helius credits (0 on a non-Helius host). */
  credits: number;
}

const METHOD_KIND: Record<string, RequestKind> = {
  getTransactionsForAddress: "gtfa",
  getSignaturesForAddress: "signatures",
  getTransaction: "transaction",
};

/** null = this request is not allowed. */
export function describeRequest(url: string, body: unknown, allowedHosts: ReadonlySet<string>): RequestInfo | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!allowedHosts.has(u.host)) return null;
  const onHelius = u.host === HELIUS_HOST;
  let parsed: { method?: unknown; params?: unknown; transactions?: unknown } | null = null;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (u.pathname === "/v0/transactions") {
    if (!onHelius || !Array.isArray(parsed.transactions)) return null;
    return { host: u.host, kind: "enhanced", credits: CREDIT_COST.enhancedTransactions };
  }
  const kind = typeof parsed.method === "string" ? METHOD_KIND[parsed.method] : undefined;
  if (!kind) return null;
  if (kind === "gtfa") {
    if (!onHelius) return null;
    const opts = Array.isArray(parsed.params) ? (parsed.params[1] as { limit?: unknown; transactionDetails?: unknown } | undefined) : undefined;
    const limit = typeof opts?.limit === "number" && opts.limit > 0 ? opts.limit : 100;
    // Worst case: a full page. Signatures-only responses cost a flat 10.
    return { host: u.host, kind, credits: opts?.transactionDetails === "full" ? CREDIT_COST.gtfaPer100 * Math.ceil(limit / 100) : CREDIT_COST.gtfaPer100 };
  }
  return { host: u.host, kind, credits: onHelius ? CREDIT_COST.standardRpc : 0 };
}
