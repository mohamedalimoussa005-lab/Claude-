/**
 * Wallet ledger (phase 1): what one wallet did in each transaction, reduced
 * to facts a PnL can trust. Anything that cannot be priced is NOT priced:
 * it stays a transfer or an undecodable entry, and the PnL engine turns it
 * into an UNKNOWN. JSON-safe.
 */

/** SOL (native + wrapped) or USD (USDC / USDT, taken at their nominal 1 USD). */
import type { RentStatus } from "./rent.ts";

export type QuoteAsset = "SOL" | "USD";

/** Signed raw token movement of the wallet. */
export interface Leg {
  mint: string;
  raw: string;
  decimals: number;
}

interface Base {
  signature: string;
  slot: number | null;
  /** Block time, ms (transactions without one are never ledgered). */
  time: number;
  /** Network fee paid by this wallet in this transaction (lamports). */
  feeLamports: number;
  /** Priority tip to a configured tip account (lamports); 0 when none is configured / found. */
  tipLamports: number;
  /** Rent the wallet deposited into accounts created here (lamports, identified only). */
  rentDepositLamports: number;
  /** Rent the wallet got back from accounts closed here (lamports, identified only). */
  rentRefundLamports: number;
  /** "uncertain": rent may be mixed into the SOL amounts and could not be separated. */
  rentStatus: RentStatus;
  flags: string[];
}

export interface TradeEntry extends Base {
  kind: "trade";
  side: "buy" | "sell";
  mint: string;
  decimals: number;
  /** Absolute raw token amount. */
  tokenRaw: string;
  tokenAmount: number;
  /**
   * TRADING amount paid (buy) / received (sell) in the quote asset.
   * SOL: network fee, tip and identified rent are taken out (see the Base fields). When `rentStatus` is
   * "uncertain" some rent may still be inside.
   * USD: the stablecoin leg only; the SOL fee stays in `unconvertedFeeSol`.
   */
  quote: { asset: QuoteAsset; amount: number };
  /** SOL trades: everything the wallet's SOL balance moved by (fee, tip, rent included); informational. */
  allInSol: number | null;
  /** USD trades only: SOL fee + tip that cannot be converted without a rate (never invented). */
  unconvertedFeeSol: number;
}

export interface TransferEntry extends Base {
  kind: "transfer";
  direction: "in" | "out";
  mint: string;
  decimals: number;
  tokenRaw: string;
  tokenAmount: number;
  reason: "not_signer" | "no_swap_program" | "no_quote_leg";
}

export type UndecodableReason = "multi_token" | "token_to_token" | "ambiguous_quote" | "quote_wrong_direction";

export interface UndecodableEntry extends Base {
  kind: "undecodable";
  reason: UndecodableReason;
  /** Token movements that happened but cannot be priced. */
  legs: Leg[];
}

export type LedgerEntry = TradeEntry | TransferEntry | UndecodableEntry;

export interface IgnoredTx {
  signature: string;
  reason: "no_block_time" | "failed" | "no_token_change" | "duplicate";
}

export interface Ledger {
  wallet: string;
  /** Chronological (time, slot, signature). */
  entries: LedgerEntry[];
  ignored: IgnoredTx[];
  /** Fees burned by failed transactions: a real cost, but attributable to no position. */
  failedFeeLamports: number;
  failedTxCount: number;
  /** Successful transactions that moved no token (account cleanup, SOL transfer…): fee and rent, tied to no position. */
  otherCosts: { feeLamports: number; rentDepositLamports: number; rentRefundLamports: number; uncertainRentTxs: number };
}

/** How far the transaction list reaches back. Incomplete = positions opened earlier are invisible. */
export interface HistoryCoverage {
  complete: boolean;
  oldestTime: number | null;
}
