/**
 * History cache: finalized transactions (by signature, indexed by wallet) and
 * pagination state (to resume a DEEP fetch after an interruption).
 * In-memory with a JSON snapshot so a server can persist it however it likes
 * (file, KV, DB). Only finalized transactions are requested, so a cached
 * transaction never changes and is never downloaded again.
 */

import type { HistoryTx } from "./types.ts";

/** A wallet's first known (succeeded) transaction. Immutable once found, so it is cached. */
export interface CachedOrigin {
  wallet: string;
  firstSeen: number | null;
  signature: string | null;
  /** How it was established. */
  method: "helius_primary_asc" | "signature_walk" | "recent_page";
  /** true = the history start was reached but held no succeeded transaction. */
  empty: boolean;
}

export interface PaginationState {
  wallet: string;
  /** Which history walk this is ("deep" = newest → oldest). */
  key: string;
  cursor: string | null;
  pages: number;
  transactions: number;
  done: boolean;
  stopReason: string | null;
  updatedAt: number;
}

export interface HistoryCache {
  getTx(signature: string): HistoryTx | undefined;
  putTx(wallet: string, tx: HistoryTx): void;
  walletTxs(wallet: string): HistoryTx[];
  getState(wallet: string, key: string): PaginationState | undefined;
  putState(state: PaginationState): void;
  getOrigin(wallet: string): CachedOrigin | undefined;
  putOrigin(origin: CachedOrigin): void;
}

/**
 * Snapshot format. v1 (step 4.1) had no `version` and no `origins`; it still
 * loads as is. Only normalized transactions, pagination state and origins:
 * no key, URL, header or upstream message.
 */
export interface HistoryCacheSnapshot {
  version?: 2;
  txs: HistoryTx[];
  wallets: Record<string, string[]>;
  states: PaginationState[];
  origins?: CachedOrigin[];
}

export class MemoryHistoryCache implements HistoryCache {
  private readonly txs = new Map<string, HistoryTx>();
  private readonly byWallet = new Map<string, Set<string>>();
  private readonly states = new Map<string, PaginationState>();
  private readonly origins = new Map<string, CachedOrigin>();

  getTx(signature: string): HistoryTx | undefined {
    return this.txs.get(signature);
  }

  putTx(wallet: string, tx: HistoryTx): void {
    // No block time = not finalized: never cached.
    if (tx.time === null) return;
    this.txs.set(tx.signature, tx);
    const set = this.byWallet.get(wallet) ?? new Set<string>();
    set.add(tx.signature);
    this.byWallet.set(wallet, set);
  }

  walletTxs(wallet: string): HistoryTx[] {
    return [...(this.byWallet.get(wallet) ?? [])].map((s) => this.txs.get(s)!).filter(Boolean);
  }

  getState(wallet: string, key: string): PaginationState | undefined {
    const s = this.states.get(`${wallet}:${key}`);
    return s ? { ...s } : undefined;
  }

  putState(state: PaginationState): void {
    this.states.set(`${state.wallet}:${state.key}`, { ...state });
  }

  getOrigin(wallet: string): CachedOrigin | undefined {
    const o = this.origins.get(wallet);
    return o ? { ...o } : undefined;
  }

  putOrigin(origin: CachedOrigin): void {
    this.origins.set(origin.wallet, { ...origin });
  }

  get size(): number {
    return this.txs.size;
  }

  snapshot(): HistoryCacheSnapshot {
    return {
      version: 2,
      txs: [...this.txs.values()],
      wallets: Object.fromEntries([...this.byWallet].map(([w, s]) => [w, [...s]])),
      states: [...this.states.values()],
      origins: [...this.origins.values()],
    };
  }

  static fromSnapshot(s: HistoryCacheSnapshot): MemoryHistoryCache {
    const c = new MemoryHistoryCache();
    for (const tx of s.txs) c.txs.set(tx.signature, tx);
    for (const [w, sigs] of Object.entries(s.wallets)) c.byWallet.set(w, new Set(sigs));
    for (const st of s.states) c.putState(st);
    for (const o of s.origins ?? []) c.putOrigin(o);
    return c;
  }
}
