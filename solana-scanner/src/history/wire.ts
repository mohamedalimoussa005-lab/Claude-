/**
 * Wire format of /api/wallet-history, shared by the Node backend
 * (server/app.ts) and the browser history client (httpSource.ts). Types only:
 * no provider internals, no URL, no key.
 */

import type { CompletionStopReason, OriginResult, QuickStatus } from "./service.ts";
import type { HistoryProviderName, HistoryStrategy, HistoryTx, PageStats, TraceStep } from "./types.ts";

export type WireMode = "quick" | "deep" | "completion";

export type ResponseStatus = QuickStatus | "deep_complete" | "deep_partial" | "upstream_partial" | "completion_complete" | "completion_partial";
export type TracePhase = "recent" | "origin" | "deep" | "quick_completion";

/** A page of the QUICK answer, by reference to `transactions` (signatures only). */
export interface QuickPageRef {
  provider: HistoryProviderName;
  strategy: HistoryStrategy;
  nextCursor: string | null;
  signatures: string[];
}

/** Everything the browser needs to rebuild the service's QUICK result (no provider internals). */
export interface QuickStructure {
  status: QuickStatus;
  recent: { page: QuickPageRef; stats: PageStats; complete: boolean };
  origin: OriginResult;
  originPage: QuickPageRef | null;
  trace: { phase: "recent" | "origin"; steps: TraceStep[] }[];
}

export interface CompletionInfo {
  reachedEnd: boolean;
  stopReason: CompletionStopReason;
  pages: number;
  trace: TraceStep[];
}

/** Counters of the QUICK recent page (null = not knowable from the provider used). */
export interface RecentStats {
  signaturesRequested: number;
  signaturesListed: number;
  transactionsFetched: number;
  transactionsFromCache: number;
  transactionsSucceeded: number | null;
  transactionsFailed: number | null;
  transactionsNormalized: number;
  missing: number;
}

export interface WalletHistoryResponse {
  address: string;
  mode: WireMode;
  status: ResponseStatus;
  provider: HistoryProviderName | null;
  providers: HistoryProviderName[];
  /** Non-sensitive provider transitions (fixed codes only). */
  providerTrace: { phase: TracePhase; steps: TraceStep[] }[];
  completeness: {
    /** QUICK: the recent page reached the end of the history. DEEP: at least one page fetched. */
    recentComplete: boolean;
    /** The wallet's first transaction is known for sure. */
    originComplete: boolean;
    /** The wallet's entire history was downloaded (rarely true for QUICK). */
    historyComplete: boolean;
  };
  resumable: boolean;
  /** QUICK: "quick_budget" or "end_of_history". DEEP: why the walk stopped. */
  stopReason: string;
  pagination: { pagesThisRun: number; pagesTotal: number };
  recent: RecentStats | null;
  origin: OriginResult | null;
  transactionCount: number;
  truncated: boolean;
  transactions: HistoryTx[];
  /** Providers that failed before one answered: provider + error kind only. */
  warnings: { provider: HistoryProviderName; kind: string }[];
  /** mode=quick only. */
  quick?: QuickStructure;
  /** mode=completion only. */
  completion?: CompletionInfo;
}

