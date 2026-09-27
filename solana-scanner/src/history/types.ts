/**
 * Wallet history access layer (step 4.1): provider-independent types.
 *
 * Every transaction, whatever its source (Helius getTransactionsForAddress,
 * Helius enhanced decoding, public RPC), is reduced to `HistoryTx`: balance
 * deltas, signers and programs. Provider labels (Helius `type` / `source`)
 * are kept only as a hint and are never used to classify anything.
 */

export type HistoryProviderName = "helius" | "public_rpc";
export type HistoryStrategy = "helius_gtfa" | "helius_signatures_enhanced" | "public_rpc";
export type HistoryOrigin = "helius-gtfa" | "helius-enhanced" | "public-rpc";
export type HistoryOrder = "desc" | "asc";

/** Token balance change of one owner for one mint (raw integer as string, JSON-safe). */
export interface TokenDeltaRaw {
  raw: string;
  decimals: number;
}

/** A transaction normalized to what the classification needs. JSON-safe (cacheable). */
export interface HistoryTx {
  signature: string;
  slot: number | null;
  /** Block time in ms. */
  time: number | null;
  failed: boolean;
  feePayer: string | null;
  signers: string[];
  /** False when the source doesn't list every signer (enhanced decoding lists only the fee payer). */
  signersComplete: boolean;
  /** Network fee in lamports. */
  fee: number;
  /** Net lamport change per account (non-zero only). */
  lamportDeltas: Record<string, number>;
  /** Net token change per owner, per mint (non-zero only). */
  tokenDeltas: Record<string, Record<string, TokenDeltaRaw>>;
  /** Programs invoked (outer and inner instructions). */
  programIds: string[];
  origin: HistoryOrigin;
  /** Provider's own label. Informational only: never trusted for BUY/SELL/TRANSFER. */
  providerHint: { type: string | null; source: string | null } | null;
}

export interface PageRequest {
  address: string;
  order: HistoryOrder;
  limit: number;
  /** Opaque cursor returned by a previous page (null = start). */
  cursor: string | null;
  /** Already-fetched finalized transactions: providers skip downloading these when they can. */
  cached?: (signature: string) => HistoryTx | undefined;
}

/** Where a trace step happened. */
export type TraceSource = "helius_primary" | "helius_enhanced" | "public_rpc";

/** Fixed, non-sensitive outcome codes (never an upstream message, URL, header or body). */
export type TraceResult =
  | "success"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "quota_exhausted"
  | "method_unavailable"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unknown"
  /** Not tried: turned off earlier in this process (see `cause`). */
  | "disabled"
  /** Not tried: not applicable to this request (e.g. a signature cursor). */
  | "skipped";

export interface TraceStep {
  source: TraceSource;
  result: TraceResult;
  /** For "disabled": the failure that turned it off. */
  cause?: TraceResult;
  /** Aggregated steps (DEEP): how many times this outcome occurred. */
  count?: number;
}

/** Counters of one page. `null` = not knowable from this source. */
export interface PageStats {
  /** Page size asked for. */
  signaturesRequested: number;
  /** Signatures (or items) the source listed, failed ones included when it lists them. */
  signaturesListed: number;
  /** Downloaded from upstream for this page (cache hits excluded). */
  transactionsFetched: number;
  transactionsFromCache: number;
  transactionsSucceeded: number | null;
  /** Failed transactions listed and left out (null when the source filtered them server-side). */
  transactionsFailed: number | null;
  /** Normalized transactions returned (succeeded only). */
  transactionsNormalized: number;
  /** Listed but not retrievable. */
  missing: number;
}

/** For oldest-first requests: whether the true start of the history was reached. */
export type OriginStatus = "reached" | "budget_exhausted" | "unsupported";

export interface HistoryPage {
  txs: HistoryTx[];
  /** Cursor for the next page in the same order, null when the history is exhausted. */
  nextCursor: string | null;
  provider: HistoryProviderName;
  strategy: HistoryStrategy;
  /** HTTP requests made for this page. */
  calls: number;
  /** For asc (oldest-first) requests: whether the true start of the history was reached. */
  reachedStart?: boolean;
  /** Signatures listed but whose transaction could not be retrieved. */
  missing: number;
  /** Set when the provider had to restart pagination (cursor from another strategy). */
  restarted?: boolean;
  note?: string;
  stats: PageStats;
  /** Oldest-first requests only. */
  originStatus?: OriginStatus;
  /**
   * Oldest-first requests only: signatures actually listed while looking for
   * the start (failed ones included), not the transactions decoded.
   */
  walkedSignatures?: number;
  /** Non-sensitive steps taken by the provider for this page. */
  trace: TraceStep[];
}

export interface HistoryLogEntry {
  provider: HistoryProviderName;
  strategy: HistoryStrategy;
  method: string;
  attempt: number;
  status: number | null;
  outcome: "ok" | "retry" | "error" | "fallback";
  note?: string;
}

/** Source of wallet histories. Callers depend on this, not on a provider. */
export interface WalletHistoryProvider {
  readonly name: HistoryProviderName;
  getPage(req: PageRequest): Promise<HistoryPage>;
}
