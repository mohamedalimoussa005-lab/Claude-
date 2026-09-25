/**
 * Wallet intelligence: every budget, rule, weight and threshold.
 *
 * Measured limits of the free public RPC (api.mainnet-beta.solana.com):
 *   - getTransaction: ~1 tx/s sustained (method limit 10 per 10 s);
 *   - active trading wallets commonly have ≥ 5,000 transactions, i.e. more
 *     than an hour of calls each, and their history start may be unreachable.
 * So wallet histories are reconstructed only when they are COMPLETE within
 * the budget below; otherwise the history metrics stay UNKNOWN. Nothing is
 * extrapolated from a partial history.
 *
 * Wallet Quality describes the quality of the available history. It is not
 * a prediction of future performance, and no wallet is a recommendation.
 */

import type { Curve } from "../scoring/config.ts";

export interface WalletConfig {
  discovery: {
    /** Pages of 1,000 signatures scanned on the mint to reach its first transaction. */
    maxMintSignaturePages: number;
    /** Earliest successful transactions decoded (≈ 1 s each). */
    earlyTransactions: number;
    /** Most recent successful transactions decoded. */
    recentTransactions: number;
    /** Buys below this (SOL) are ignored as dust. */
    minBuySol: number;
    /** Wallets kept per token for the per-wallet checks. */
    shortlist: number;
  };
  history: {
    /** Signature pages fetched per wallet to size its history (5 × 1,000). */
    signaturePages: number;
    /** A history is reconstructed only if the wallet has at most this many signatures. */
    maxSignaturesForFullHistory: number;
    /** Global budget of history transactions per run. */
    maxHistoryTransactionsPerRun: number;
  };
  flags: {
    /** ≥ this many signatures (the page cap) → bot-like / high-frequency. */
    busySignatures: number;
    /** First activity less than this many hours before its entry → recently created wallet. */
    freshWalletHours: number;
    /** Funded less than this many minutes before the token launch. */
    fundedBeforeLaunchMinutes: number;
    /** Average ticket under this (SOL) with many transactions → micro-transactions. */
    microTicketSol: number;
    /** Distinct tokens bought per 100 transactions above this → buys almost every new token. */
    tokensPer100Txs: number;
  };
  quality: {
    /** Closed or valued positions in the reconstructed history → points. */
    sampleSize: { max: number; curve: Curve };
    /** Share of profitable positions, weighted by sample size. */
    consistency: { max: number; curve: Curve; fullAtTrades: number };
    /** Share of positions entered < 1 h after launch (where the launch is known). */
    earlyEntry: { max: number; curve: Curve };
    /** Median return (×, e.g. 0.2 = +20 %) → points. */
    realized: { max: number; curve: Curve };
    /** Worst position return → points (a −100 % wipe-out earns nothing). */
    riskAdjusted: { max: number; curve: Curve };
    /** Points when the history is complete. */
    completeness: { max: number };
    /** Penalty points per flag severity. */
    penalties: { high: number; medium: number; low: number };
  };
  confidence: {
    /** HIGH needs a complete history with at least this many positions. */
    highMinPositions: number;
    mediumMinPositions: number;
  };
  /** Wallet Quality at or above this with Confidence ≥ MEDIUM counts as a "high-quality history". */
  highQualityThreshold: number;
}

export const WALLET_CONFIG: WalletConfig = {
  discovery: {
    maxMintSignaturePages: 25,
    earlyTransactions: 40,
    recentTransactions: 20,
    minBuySol: 0.05,
    shortlist: 8,
  },
  history: {
    signaturePages: 5,
    maxSignaturesForFullHistory: 150,
    maxHistoryTransactionsPerRun: 300,
  },
  flags: {
    busySignatures: 5_000,
    freshWalletHours: 48,
    fundedBeforeLaunchMinutes: 60,
    microTicketSol: 0.01,
    tokensPer100Txs: 25,
  },
  quality: {
    sampleSize: {
      max: 25,
      curve: [
        [0, 0],
        [3, 4],
        [10, 12],
        [25, 20],
        [50, 25],
      ],
    },
    consistency: {
      max: 15,
      curve: [
        [0.2, 0],
        [0.4, 6],
        [0.55, 12],
        [0.7, 15],
      ],
      fullAtTrades: 20,
    },
    earlyEntry: {
      max: 10,
      curve: [
        [0, 0],
        [0.2, 4],
        [0.5, 10],
      ],
    },
    realized: {
      max: 15,
      curve: [
        [-0.5, 0],
        [0, 5],
        [0.3, 12],
        [1, 15],
      ],
    },
    riskAdjusted: {
      max: 15,
      curve: [
        [-1, 0],
        [-0.7, 5],
        [-0.3, 12],
        [0, 15],
      ],
    },
    completeness: { max: 20 },
    penalties: { high: 25, medium: 12, low: 5 },
  },
  confidence: { highMinPositions: 25, mediumMinPositions: 10 },
  highQualityThreshold: 60,
};

export const WALLET_DISCLAIMER =
  "Wallet Quality décrit la qualité de l'historique disponible, pas une performance future. Une adresse n'est pas une " +
  "personne, et aucun wallet ni token n'est une recommandation d'achat. Les wallets liés sont des heuristiques.";
