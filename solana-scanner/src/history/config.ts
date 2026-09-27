/**
 * Wallet history access: budgets and endpoints. No secret here: the Helius API
 * key is injected server-side at construction (see server/heliusEnv.ts).
 *
 * Documented Helius facts this relies on (heliusKnowledge, 2026-09):
 *   - getTransactionsForAddress (JSON-RPC): paginationToken "slot:position",
 *     sortOrder asc|desc, limit ≤ 1000 in "full" mode, 10 credits / 100 full
 *     transactions — documented "Developer plan+ only", so never assumed.
 *   - Fallback: getSignaturesForAddress (1 credit) + POST /v0/transactions
 *     (enhanced decoding, ≤ 100 signatures, 100 credits per request).
 *   - Free plan: ~2 req/s on the enhanced API.
 */

export interface HistoryConfig {
  helius: {
    rpcUrl: string;
    enhancedUrl: string;
    /** Requests per second (client-side limiter). */
    maxRequestsPerSecond: number;
    maxRetries: number;
    timeoutMs: number;
    /** Hard cap per getTransactionsForAddress page ("full": 1000). */
    maxPrimaryLimit: number;
    /** Max signatures per /v0/transactions call. */
    enhancedBatch: number;
    /** Signature pages walked (1,000 each) to find the oldest transactions in fallback mode. */
    fallbackOldestSignaturePages: number;
    status: "succeeded" | "any";
  };
  publicRpc: {
    /** Transactions per page: the public RPC serves ~1 getTransaction/s. */
    maxPageLimit: number;
    oldestSignaturePages: number;
  };
  quick: {
    recentLimit: number;
    oldestLimit: number;
  };
  deep: {
    pageLimit: number;
    maxPages: number;
    maxTransactions: number;
    /** DEEP is only for selected wallets: at most this many distinct wallets per service instance. */
    maxWalletsPerRun: number;
  };
}

export const HISTORY_CONFIG: HistoryConfig = {
  helius: {
    rpcUrl: "https://mainnet.helius-rpc.com/",
    enhancedUrl: "https://mainnet.helius-rpc.com/v0/transactions",
    maxRequestsPerSecond: 2,
    maxRetries: 3,
    timeoutMs: 20_000,
    maxPrimaryLimit: 1000,
    enhancedBatch: 100,
    fallbackOldestSignaturePages: 10,
    status: "succeeded",
  },
  publicRpc: {
    maxPageLimit: 25,
    oldestSignaturePages: 5,
  },
  quick: {
    recentLimit: 100,
    oldestLimit: 20,
  },
  deep: {
    pageLimit: 100,
    maxPages: 50,
    maxTransactions: 5000,
    maxWalletsPerRun: 8,
  },
};
