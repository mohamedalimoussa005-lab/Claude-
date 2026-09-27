/**
 * History cache: finalized transactions (by signature, indexed by wallet) and
 * pagination state (to resume a DEEP fetch after an interruption).
 * In-memory with a JSON snapshot so a server can persist it however it likes
 * (file, KV, DB). Only finalized transactions are requested, so a cached
 * transaction never changes and is never downloaded again.
 */

import type { HistoryTx } from "./types.ts";

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
}

export interface HistoryCacheSnapshot {
  txs: HistoryTx[];
  wallets: Record<string, string[]>;
  states: PaginationState[];
}

export class MemoryHistoryCache implements HistoryCache {
  private readonly txs = new Map<string, HistoryTx>();
  private readonly byWallet = new Map<string, Set<string>>();
  private readonly states = new Map<string, PaginationState>();

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

  get size(): number {
    return this.txs.size;
  }

  snapshot(): HistoryCacheSnapshot {
    return {
      txs: [...this.txs.values()],
      wallets: Object.fromEntries([...this.byWallet].map(([w, s]) => [w, [...s]])),
      states: [...this.states.values()],
    };
  }

  static fromSnapshot(s: HistoryCacheSnapshot): MemoryHistoryCache {
    const c = new MemoryHistoryCache();
    for (const tx of s.txs) c.txs.set(tx.signature, tx);
    for (const [w, sigs] of Object.entries(s.wallets)) c.byWallet.set(w, new Set(sigs));
    for (const st of s.states) c.putState(st);
    return c;
  }
}
