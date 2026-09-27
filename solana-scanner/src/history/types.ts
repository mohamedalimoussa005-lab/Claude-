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
