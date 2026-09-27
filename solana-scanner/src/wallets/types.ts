import type { FailureKind } from "../history/failure.ts";
import type { TraceStep } from "../history/types.ts";
import type { OriginResult } from "../history/service.ts";
import type { BotSignals } from "./botSignals.ts";
import type { Trade } from "./trades.ts";

/** A token movement that is not a trade (step 4.2): kept for relationships, never a BUY/SELL. */
export interface TokenTransfer {
  signature: string;
  time: number | null;
  mint: string;
  direction: "in" | "out";
  /** UI units. */
  amount: number;
  /** Owners whose balance of the same token moved the other way. */
  counterparties: string[];
}

/** Stage of a wallet analysis that could not be completed (step 4.2b). */
export type WalletStage = "signatures" | "funding" | "history" | "creator" | "funder_check";

/** Why part of a wallet's facts is UNKNOWN. Codes only: never an upstream message, never a scoring input. */
export interface WalletFailure {
  kind: FailureKind;
  stages: { stage: WalletStage; kind: FailureKind }[];
  /** Nothing was fetched for this wallet (circuit open / source down). */
  skipped: boolean;
}

/** What the history layer adds to the facts (step 4.2 path only). */
export interface HistoryExtras {
  mode: "quick" | "deep";
  /** Why the history is (in)complete. */
  completeness: "recent_page_covers_history" | "quick_completion_complete" | "deep_complete" | "incomplete";
  /** signatureCount is a lower bound (the history was not fully listed). */
  signatureCountIsLowerBound: boolean;
  origin: OriginResult;
  bot: BotSignals;
  transfers: TokenTransfer[];
  /** QUICK completion (step 4.2c): a few pages after QUICK for a short history. Not DEEP. */
  quickCompletion: { attempted: boolean; skippedReason: string | null; stopReason: string | null; pages: number };
  deep: { attempted: boolean; skippedReason: string | null; stopReason: string | null };
  providerTrace: { phase: string; steps: TraceStep[] }[];
  /** UNKNOWN / NOT VERIFIED items (never turned into negative signals). */
  unknowns: string[];
}

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
  /** Set only by the history-layer collector (step 4.2). */
  history?: HistoryExtras;
  /** Set when a provider / RPC failure left part of the facts UNKNOWN (step 4.2b). */
  failure?: WalletFailure;
}

/** Launch info known for some tokens (the scanner candidates). */
export type LaunchTimes = Record<string, number>;

/** Current price in SOL per token (DEX Screener), for unrealised estimates. */
export type PricesSol = Record<string, number>;
