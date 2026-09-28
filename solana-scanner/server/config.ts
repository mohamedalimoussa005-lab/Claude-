/**
 * Wallet history API: every server-side limit. No secret here.
 */

import { WALLET_CONFIG } from "../src/wallets/config.ts";

export interface ServerConfig {
  port: number;
  /** Only loopback: the API is local-only in this first version. */
  host: string;
  /** Accepted Host headers (anti DNS-rebinding), without port. */
  allowedHosts: string[];
  rateLimit: {
    windowMs: number;
    quickPerWindow: number;
    deepPerWindow: number;
  };
  /** Analyses running at once; more are refused (503), not queued. */
  maxConcurrent: number;
  /** The HTTP answer is sent after this; the analysis keeps its concurrency slot until it really ends. */
  timeoutMs: number;
  maxResponseBytes: number;
  /** Budget of one DEEP analysis (clamps the history config). */
  deep: { maxPages: number; maxTransactions: number };
  /** Budget of one QUICK completion request from the browser (same as the Wallet Intelligence QUICK completion). */
  completion: { maxPages: number; maxTransactions: number; pageLimit: number };
}

export const SERVER_CONFIG: ServerConfig = {
  port: 8787,
  host: "127.0.0.1",
  allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
  rateLimit: {
    windowMs: 60_000,
    quickPerWindow: 30,
    deepPerWindow: 3,
  },
  maxConcurrent: 2,
  timeoutMs: 60_000,
  maxResponseBytes: 2_000_000,
  deep: { maxPages: 20, maxTransactions: 2000 },
  completion: {
    maxPages: WALLET_CONFIG.historyLayer.quickCompletion.maxAdditionalPages,
    maxTransactions: WALLET_CONFIG.historyLayer.quickCompletion.maxAdditionalTransactions,
    pageLimit: WALLET_CONFIG.historyLayer.quickCompletion.pageLimit,
  },
};
