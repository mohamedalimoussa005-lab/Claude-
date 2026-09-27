/**
 * Reduces provider payloads to `HistoryTx`.
 *
 * - Full transactions (public RPC getTransaction, Helius getTransactionsForAddress
 *   "full"/jsonParsed) carry pre/post balances and signer flags: deltas are
 *   computed with the step 4 helper `tokenDeltasByOwner`.
 * - Helius enhanced decoding (/v0/transactions) carries per-account deltas
 *   (accountData) but lists only the fee payer, so `signersComplete` is false.
 * Helius `type` / `source` go to `providerHint` and nothing else.
 */

import type { ParsedInstruction, ParsedTransaction } from "../onchain/rpc.ts";
import { tokenDeltasByOwner } from "../wallets/trades.ts";
import type { HistoryOrigin, HistoryTx, TokenDeltaRaw } from "./types.ts";

export function normalizeParsed(tx: ParsedTransaction, origin: HistoryOrigin, hint: HistoryTx["providerHint"] = null): HistoryTx {
  const keys = tx.transaction.message.accountKeys;
  const lamportDeltas: Record<string, number> = {};
  if (tx.meta) {
    keys.forEach((k, i) => {
      const d = (tx.meta!.postBalances[i] ?? 0) - (tx.meta!.preBalances[i] ?? 0);
      if (d !== 0) lamportDeltas[k.pubkey] = (lamportDeltas[k.pubkey] ?? 0) + d;
    });
  }
  const tokenDeltas: Record<string, Record<string, TokenDeltaRaw>> = {};
  for (const [owner, mints] of tokenDeltasByOwner(tx)) {
    for (const [mint, d] of mints) {
      if (d.raw === 0n) continue;
      (tokenDeltas[owner] ??= {})[mint] = { raw: d.raw.toString(), decimals: d.decimals };
    }
  }
  const programs = new Set<string>();
  const addProgram = (ix: ParsedInstruction) => ix.programId && programs.add(ix.programId);
  tx.transaction.message.instructions.forEach(addProgram);
  for (const inner of tx.meta?.innerInstructions ?? []) inner.instructions.forEach(addProgram);
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot ?? null,
    time: tx.blockTime ? tx.blockTime * 1000 : null,
    failed: !!tx.meta?.err,
    feePayer: keys[0]?.pubkey ?? null,
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey),
    signersComplete: true,
    fee: tx.meta?.fee ?? 0,
    lamportDeltas,
    tokenDeltas,
    programIds: [...programs],
    origin,
    providerHint: hint,
  };
}

/** The fields of a Helius enhanced transaction (/v0/transactions) that we read. */
export interface EnhancedTransaction {
  signature: string;
  slot?: number | null;
  timestamp?: number | null;
  fee?: number;
  feePayer?: string;
  type?: string | null;
  source?: string | null;
  transactionError?: unknown;
  accountData?: {
    account: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: { userAccount?: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
  }[];
  instructions?: { programId?: string; innerInstructions?: { programId?: string }[] }[];
}

export function normalizeEnhanced(tx: EnhancedTransaction): HistoryTx {
  const lamportDeltas: Record<string, number> = {};
  const sums = new Map<string, Map<string, { raw: bigint; decimals: number }>>();
  for (const a of tx.accountData ?? []) {
    if (a.nativeBalanceChange) lamportDeltas[a.account] = (lamportDeltas[a.account] ?? 0) + a.nativeBalanceChange;
    for (const t of a.tokenBalanceChanges ?? []) {
      if (!t.userAccount) continue;
      const m = sums.get(t.userAccount) ?? new Map<string, { raw: bigint; decimals: number }>();
      const cur = m.get(t.mint) ?? { raw: 0n, decimals: t.rawTokenAmount.decimals };
      m.set(t.mint, { raw: cur.raw + BigInt(t.rawTokenAmount.tokenAmount), decimals: t.rawTokenAmount.decimals });
      sums.set(t.userAccount, m);
    }
  }
  const tokenDeltas: Record<string, Record<string, TokenDeltaRaw>> = {};
  for (const [owner, mints] of sums) {
    for (const [mint, d] of mints) if (d.raw !== 0n) (tokenDeltas[owner] ??= {})[mint] = { raw: d.raw.toString(), decimals: d.decimals };
  }
  const programs = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    if (ix.programId) programs.add(ix.programId);
    for (const inner of ix.innerInstructions ?? []) if (inner.programId) programs.add(inner.programId);
  }
  return {
    signature: tx.signature,
    slot: tx.slot ?? null,
    time: tx.timestamp ? tx.timestamp * 1000 : null,
    failed: tx.transactionError !== null && tx.transactionError !== undefined,
    feePayer: tx.feePayer ?? null,
    signers: tx.feePayer ? [tx.feePayer] : [],
    signersComplete: false,
    fee: tx.fee ?? 0,
    lamportDeltas,
    tokenDeltas,
    programIds: [...programs],
    origin: "helius-enhanced",
    providerHint: { type: tx.type ?? null, source: tx.source ?? null },
  };
}
