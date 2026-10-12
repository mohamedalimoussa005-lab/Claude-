/** The three analysis modes. Every number is configurable (withMode) and every cap that is hit is reported. */

import type { ModeName } from "./types.ts";

export interface ModeConfig {
  name: ModeName;
  /** Hard cap on RPC calls through the budgeted client. */
  maxCalls: number;
  /** Hard cap on wall-clock time of the whole analysis. */
  maxMs: number;
  /** Overrides of the existing on-chain collector (holder wallets histories, creator transactions). */
  onchain: { holderWallets: number; creatorTransactions: number; mintSignaturePages: number };
  launch: {
    /** Pages of 1,000 signatures read on the mint (the launch is reached only if the history fits). */
    maxSignaturePages: number;
    /** Oldest successful transactions of the mint that are fetched and decoded. */
    earlyTransactions: number;
    /** Cohort wallets whose funding is traced (5C: at most 50). */
    cohortWallets: number;
    /** Funding hops (5C: 1 or 2). */
    hops: number;
    /** Pages of signatures read per traced wallet, and oldest transactions fetched per wallet. */
    walletSignaturePages: number;
    walletTransactions: number;
  };
}

export const MODES: Record<ModeName, ModeConfig> = {
  rapide: {
    name: "rapide",
    maxCalls: 150,
    maxMs: 4 * 60_000,
    onchain: { holderWallets: 0, creatorTransactions: 6, mintSignaturePages: 2 },
    launch: { maxSignaturePages: 3, earlyTransactions: 50, cohortWallets: 12, hops: 1, walletSignaturePages: 1, walletTransactions: 6 },
  },
  standard: {
    name: "standard",
    maxCalls: 450,
    maxMs: 10 * 60_000,
    onchain: { holderWallets: 4, creatorTransactions: 12, mintSignaturePages: 3 },
    launch: { maxSignaturePages: 15, earlyTransactions: 150, cohortWallets: 30, hops: 2, walletSignaturePages: 2, walletTransactions: 6 },
  },
  profond: {
    name: "profond",
    maxCalls: 1100,
    maxMs: 20 * 60_000,
    onchain: { holderWallets: 10, creatorTransactions: 12, mintSignaturePages: 3 },
    launch: { maxSignaturePages: 60, earlyTransactions: 250, cohortWallets: 50, hops: 2, walletSignaturePages: 3, walletTransactions: 6 },
  },
};

export function parseMode(s: string | undefined): ModeName {
  const v = (s ?? "standard").toLowerCase();
  if (v === "rapide" || v === "standard" || v === "profond") return v;
  throw new Error(`mode inconnu "${s}" (rapide | standard | profond)`);
}

type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };
export function withMode(name: ModeName, over: Deep<ModeConfig> = {}): ModeConfig {
  const base = structuredClone(MODES[name]);
  return { ...base, ...over, onchain: { ...base.onchain, ...over.onchain }, launch: { ...base.launch, ...over.launch } } as ModeConfig;
}
