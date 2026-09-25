/**
 * On-chain safety analysis: every source, limit, rule, weight and threshold.
 *
 * This layer is independent from the DEX Screener scores. It never says a
 * token is "safe": it lists what could be verified on-chain, what looks
 * risky, and what stays UNKNOWN. Unknown data never lowers the risk.
 *
 * Curves use the same format as src/scoring/config.ts: [x, y] points,
 * linear interpolation, clamped at both ends; y = risk points.
 */

import type { Curve } from "../scoring/config.ts";

/**
 * Programs and fixed addresses used to recognise technical token holders.
 * Each id was checked on mainnet (program accounts are executable; the
 * authorities are system-owned PDAs holding pool funds). A holder is only
 * classified as technical through one of these, or when its owner is the
 * DEX Screener pair address.
 */
export const KNOWN_PROGRAMS: Record<string, { name: string; kind: "pool" | "bondingCurve" }> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": { name: "pump.fun bonding curve", kind: "bondingCurve" },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { name: "PumpSwap pool", kind: "pool" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { name: "Raydium AMM v4 pool", kind: "pool" },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: { name: "Raydium CPMM pool", kind: "pool" },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: "Raydium CLMM pool", kind: "pool" },
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: { name: "Raydium LaunchLab bonding curve", kind: "bondingCurve" },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: "Orca Whirlpool", kind: "pool" },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: "Meteora DLMM pool", kind: "pool" },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: { name: "Meteora DAMM v2 pool", kind: "pool" },
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: { name: "Meteora DAMM v1 pool", kind: "pool" },
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi": { name: "Meteora vault", kind: "pool" },
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: { name: "Meteora Dynamic Bonding Curve", kind: "bondingCurve" },
};

export const KNOWN_ADDRESSES: Record<string, { name: string; kind: "pool" | "burn" }> = {
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": { name: "Raydium AMM v4 authority", kind: "pool" },
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: { name: "Raydium CPMM authority", kind: "pool" },
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: { name: "Meteora DAMM v2 pool authority", kind: "pool" },
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: { name: "Meteora DBC pool authority", kind: "pool" },
  "1nc1nerator11111111111111111111111111111111": { name: "Incinerator (burn)", kind: "burn" },
  "11111111111111111111111111111111": { name: "System program (burn)", kind: "burn" },
};

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export interface OnchainConfig {
  rpc: {
    /** Default public endpoint. Override with VITE_SOLANA_RPC_URL / SOLANA_RPC_URL. */
    url: string;
    /** Sliding-window limit applied client-side (public mainnet: 100 req / 10 s per IP, 40 per method). */
    maxRequests: number;
    windowMs: number;
    /** Stricter per-method limits (same window) for the expensive calls. */
    perMethod: Record<string, number>;
    timeoutMs: number;
    maxRetries: number;
  };
  cacheTtlMs: { mint: number; holders: number; accounts: number; signatures: number; transaction: number; balance: number };
  /** Which scanner rows get an on-chain analysis automatically. */
  candidates: { max: number; minOpportunity: number; maxDexRisk: number; minQuality: number };
  holders: { topN: number; classifyTop: number };
  creator: { recentSignatures: number; analyzeTransactions: number; mintSignaturePages: number };
  clusters: {
    /** Largest non-technical holders analysed for relationships. */
    wallets: number;
    /** Signatures fetched per wallet (one page). */
    signatureLimit: number;
    /** First activity within this many minutes = weak timing signal. */
    closeCreationMinutes: number;
    /** A SOL transfer below this is not treated as funding. */
    minFundingSol: number;
    /** A funder with at least this many signatures (one page) is treated as a busy service / exchange. */
    busyFunderSignatures: number;
    /** Distinct shared funders whose activity is checked. */
    maxFundersChecked: number;
  };
  score: {
    authorities: {
      max: number;
      mintActive: number;
      freezeActive: number;
      unknownEach: number;
      permanentDelegate: number;
      transferHook: number;
      /** Transfer fee in basis points → risk points. */
      transferFee: Curve;
      defaultFrozen: number;
      nonTransferable: number;
    };
    concentration: {
      max: number;
      /** Largest non-technical holder, % (adjusted). */
      top1: Curve;
      top5: Curve;
      top10: Curve;
      /** Number of holders with a non-zero balance. */
      holderCount: Curve;
      /** Extra points when the top 10 (adjusted) reaches `top10`. */
      extreme: { top10: number; points: number };
      /** Points when the holder list is unavailable. */
      unknown: number;
    };
    creator: {
      max: number;
      unknown: number;
      /** % of supply held by the deployment-associated wallet. */
      holding: Curve;
      /** Sells among recent analysed transactions. */
      sells: Curve;
      /** % of supply sold in those transactions. */
      soldPct: Curve;
      /** Distinct non-technical wallets that received tokens from it. */
      transferRecipients: Curve;
      /** Points when its activity could not be analysed. */
      activityUnknown: number;
    };
    relationships: {
      max: number;
      /** Combined % (adjusted) held by the largest group of potentially related wallets. */
      groupShare: Curve;
      /** Number of strong links (same funding tx, funded by another holder, shared tx). */
      strongLinks: Curve;
      unknown: number;
    };
    completeness: {
      max: number;
      /** Points per unavailable data section. */
      missing: { mint: number; holders: number; owners: number; creator: number; creatorActivity: number; wallets: number };
    };
  };
  confidence: {
    parts: { mint: number; holders: number; owners: number; creator: number; creatorActivity: number; wallets: number };
    high: number;
    medium: number;
  };
}

export const ONCHAIN_CONFIG: OnchainConfig = {
  rpc: {
    url: "https://api.mainnet-beta.solana.com",
    maxRequests: 30,
    windowMs: 10_000,
    perMethod: { getTransaction: 10, getSignaturesForAddress: 10, getProgramAccounts: 3, getBalance: 10 },
    timeoutMs: 25_000,
    maxRetries: 5,
  },
  cacheTtlMs: {
    mint: 10 * 60_000,
    holders: 3 * 60_000,
    accounts: 10 * 60_000,
    signatures: 3 * 60_000,
    transaction: 24 * 60 * 60_000,
    balance: 3 * 60_000,
  },
  candidates: { max: 5, minOpportunity: 50, maxDexRisk: 49, minQuality: 40 },
  holders: { topN: 20, classifyTop: 30 },
  creator: { recentSignatures: 25, analyzeTransactions: 12, mintSignaturePages: 3 },
  clusters: { wallets: 10, signatureLimit: 1000, closeCreationMinutes: 10, minFundingSol: 0.01, busyFunderSignatures: 1000, maxFundersChecked: 5 },
  score: {
    authorities: {
      max: 20,
      mintActive: 12,
      freezeActive: 10,
      unknownEach: 6,
      permanentDelegate: 12,
      transferHook: 6,
      transferFee: [
        [0, 0],
        [100, 3],
        [500, 6],
      ],
      defaultFrozen: 8,
      nonTransferable: 12,
    },
    concentration: {
      max: 30,
      top1: [
        [5, 0],
        [10, 3],
        [20, 8],
        [40, 14],
        [60, 16],
      ],
      top5: [
        [15, 0],
        [30, 4],
        [50, 9],
        [70, 12],
      ],
      top10: [
        [25, 0],
        [40, 4],
        [60, 8],
        [80, 11],
      ],
      extreme: { top10: 70, points: 8 },
      holderCount: [
        [30, 4],
        [100, 2],
        [300, 0],
      ],
      unknown: 18,
    },
    creator: {
      max: 20,
      unknown: 6,
      holding: [
        [0.5, 0],
        [2, 3],
        [5, 6],
        [15, 10],
      ],
      sells: [
        [0, 0],
        [1, 3],
        [3, 6],
      ],
      soldPct: [
        [0.5, 0],
        [2, 3],
        [5, 6],
      ],
      transferRecipients: [
        [1, 0],
        [2, 3],
        [5, 6],
      ],
      activityUnknown: 4,
    },
    relationships: {
      max: 15,
      groupShare: [
        [2, 0],
        [5, 4],
        [10, 8],
        [20, 12],
      ],
      strongLinks: [
        [0, 0],
        [1, 2],
        [3, 3],
      ],
      unknown: 6,
    },
    completeness: {
      max: 15,
      missing: { mint: 6, holders: 5, owners: 2, creator: 2, creatorActivity: 1, wallets: 2 },
    },
  },
  confidence: {
    parts: { mint: 25, holders: 25, owners: 15, creator: 15, creatorActivity: 10, wallets: 10 },
    high: 80,
    medium: 50,
  },
};

export const ONCHAIN_DISCLAIMER =
  "L'analyse on-chain décrit ce qui a pu être vérifié sur la blockchain. Elle ne dit jamais qu'un token est « safe » " +
  "et n'est pas une recommandation d'achat. Les regroupements de wallets sont des heuristiques, pas des preuves.";
