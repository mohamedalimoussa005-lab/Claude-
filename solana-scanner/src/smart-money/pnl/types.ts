import type { HistoryCoverage, QuoteAsset } from "../ledger/types.ts";

/**
 * KNOWN: every buy and sell was priced, rent was separated or absent, and the history reaches back to the wallet's first transaction.
 * PARTIAL: priced, but part of the amounts could not be attributed with certainty (rent that may be mixed into the SOL
 * amounts, see `partialReasons`). The PnL shown is all-in and approximate; it is kept out of the statistics.
 * PROVISIONAL: priced, but the history is incomplete, so an earlier holding of the same token cannot be excluded.
 * UNKNOWN: some leg could not be priced (see `unknownReasons`); no PnL is produced.
 */
export type RoundStatus = "KNOWN" | "PARTIAL" | "PROVISIONAL" | "UNKNOWN";

export type PartialReason = "rent_unattributed";

export type UnknownReason =
  | "transfer_in_unknown_cost"
  | "undecodable_tx"
  | "sell_without_known_buy"
  | "sold_unknown_cost_lot"
  | "transferred_out"
  | "mixed_quote";

/** One position of one token, from the moment the wallet holds it until the holding returns to zero. */
export interface Round {
  mint: string;
  openedAt: number;
  closedAt: number;
  holdSeconds: number;
  status: RoundStatus;
  unknownReasons: UnknownReason[];
  partialReasons: PartialReason[];
  /** Quote asset of the whole round; null when mixed or never priced. */
  quote: QuoteAsset | null;
  /** TRADING cost of the round's buys: network fee, tip and identified rent excluded (null when UNKNOWN). */
  cost: number | null;
  /** TRADING proceeds of the sells, same convention. */
  proceeds: number | null;
  /** proceeds − cost, before fees and tips. */
  tradingPnl: number | null;
  /** Result after network fees and tips (SOL rounds); rent is capital, not result, and is excluded. USD rounds: = tradingPnl. */
  pnl: number | null;
  /** pnl / (cost + fees + tips). */
  roi: number | null;
  /** Network fees / tips paid by the round's trades (SOL rounds; already deducted from `pnl`). */
  feesSol: number;
  tipsSol: number;
  /** Rent deposited into / recovered from token accounts by the round's trades and transfers (identified only). */
  rentDepositedSol: number;
  rentRecoveredSol: number;
  /** USD rounds: SOL fees that could not be converted and are NOT in the USD PnL. */
  unconvertedFeesSol: number;
  buys: number;
  sells: number;
  /** A last sliver (≤ dustRatio of the peak) was written off instead of kept open. */
  dustWrittenOff: boolean;
  signatures: string[];
}

export interface MarkPrice {
  /** Quote units per token (UI units). Supplied by the caller with its provenance; never fetched here. */
  price: number;
  quote: QuoteAsset;
  asOf: number;
  source: string;
}

export interface OpenPosition {
  mint: string;
  status: "OPEN";
  openedAt: number;
  amount: number;
  /** Cost of the still-held lots whose cost is known (null when none is). */
  knownCost: number | null;
  hasUnknownLots: boolean;
  quote: QuoteAsset | null;
  /** Profit already booked by sales inside this position (matched known lots only). null when not computable. */
  realizedSoFar: number | null;
  /** Needs a supplied mark price and a fully known cost; otherwise null (UNKNOWN, never 0). */
  unrealized: { value: number; mark: MarkPrice } | null;
  unknownReasons: UnknownReason[];
  /** Signatures of the transactions behind this position (the evidence). */
  signatures: string[];
}

export interface PnlResult {
  wallet: string;
  coverage: HistoryCoverage;
  rounds: Round[];
  open: OpenPosition[];
  failedFeeSol: number;
  failedTxCount: number;
  ignoredTxCount: number;
  /** Wallet-level split of what is not trading, over every transaction of the ledger. */
  costs: {
    feesSol: number;
    tipsSol: number;
    rentDepositedSol: number;
    rentRecoveredSol: number;
    /** Transactions whose rent could not be attributed (their amounts stay inside the trades). */
    uncertainRentTxs: number;
  };
}
