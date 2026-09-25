import type { Trade } from "./trades.ts";

/** What was scanned on the token itself. */
export interface TokenScan {
  mint: string;
  /** First transaction of the mint, when the scan reached it. */
  launch: { time: number | null; slot: number | null; signature: string } | null;
  signaturesScanned: number;
  launchReachable: boolean;
  transactionsFetched: number;
  transactionsFailed: number;
  undecodable: number;
  earlyTrades: Trade[];
  recentTrades: Trade[];
  /** Token supply in UI units, for entry market cap. */
  supply: number | null;
  /** SOL/USD at scan time (DEX Screener), for estimates only. */
  solUsd: number | null;
}

/** Per-wallet facts gathered by the collector (no scoring). */
export interface WalletFacts {
  address: string;
  /** Signatures found (capped at pages × 1,000). */
  signatureCount: number;
  historyComplete: boolean;
  firstSeen: number | null;
  funder: string | null;
  fundingSignature: string | null;
  fundingTime: number | null;
  funderSignatureCount: number | null;
  /** First page of signatures, for shared-transaction checks. */
  signatures: string[];
  /** Complete trade history when reconstructed; null when not reconstructible. */
  trades: Trade[] | null;
  historyNote: string;
  /** Transactions that could not be decoded as trades (transfers, routes…). */
  undecodableTxs: number;
}

/** Launch info known for some tokens (the scanner candidates). */
export type LaunchTimes = Record<string, number>;

/** Current price in SOL per token (DEX Screener), for unrealised estimates. */
export type PricesSol = Record<string, number>;
