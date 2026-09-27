/**
 * BUY / SELL / TRANSFER / UNKNOWN for one wallet in one transaction, from
 * balance changes only — the same rules as step 4's `decodeTrade`:
 *   - exactly one non-SOL token changed for the wallet, and
 *   - its SOL (lamports + wrapped SOL) moved the opposite way.
 * Plus two guards:
 *   - only a wallet that signed can trade (a pool / curve never signs);
 *   - a transaction touching only system / token / ATA / compute-budget /
 *     memo programs cannot be a swap: it is a TRANSFER whatever the SOL moves
 *     (e.g. the recipient paying rent for its token account).
 * The provider label (`providerHint`) is never read: Helius tags some
 * pump.fun buys as TRANSFER and some transfers as SWAP (DOGRILLA benchmark).
 */

import { WSOL_MINT } from "../wallets/trades.ts";
import type { Trade } from "../wallets/trades.ts";
import type { HistoryTx } from "./types.ts";

export type HistoryKind = "BUY" | "SELL" | "TRANSFER" | "UNKNOWN";

export interface Classification {
  kind: HistoryKind;
  reason: string;
  mint: string | null;
  /** Token amount in UI units (absolute). */
  tokenAmount: number | null;
  /** Net SOL flow of the wallet (signed, fees included). */
  sol: number;
}

/** Programs that move balances without swapping. */
export const NON_SWAP_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

export function walletSolFlow(tx: HistoryTx, wallet: string): number {
  const wsol = tx.tokenDeltas[wallet]?.[WSOL_MINT];
  return (tx.lamportDeltas[wallet] ?? 0) / 1e9 + (wsol ? Number(BigInt(wsol.raw)) / 10 ** wsol.decimals : 0);
}

function signed(tx: HistoryTx, wallet: string): boolean {
  if (tx.signers.includes(wallet)) return true;
  // Enhanced decoding lists only the fee payer; a wallet whose lamports went down must have signed.
  return !tx.signersComplete && (tx.lamportDeltas[wallet] ?? 0) < 0;
}

export function classifyForWallet(tx: HistoryTx, wallet: string): Classification {
  const sol = walletSolFlow(tx, wallet);
  const base = { mint: null, tokenAmount: null, sol };
  if (tx.failed) return { kind: "UNKNOWN", reason: "failed", ...base };
  const tokens = Object.entries(tx.tokenDeltas[wallet] ?? {}).filter(([m, d]) => m !== WSOL_MINT && BigInt(d.raw) !== 0n);
  if (tokens.length === 0) {
    const lamports = tx.lamportDeltas[wallet] ?? 0;
    const feeOnly = tx.feePayer === wallet && lamports === -tx.fee;
    if (lamports !== 0 && !feeOnly) return { kind: "TRANSFER", reason: "sol_only", ...base };
    return { kind: "UNKNOWN", reason: "no_change", ...base };
  }
  if (tokens.length > 1) return { kind: "UNKNOWN", reason: "multi_token", ...base };
  const [mint, d] = tokens[0];
  const raw = BigInt(d.raw);
  const tokenAmount = Math.abs(Number(raw)) / 10 ** d.decimals;
  const withToken = { mint, tokenAmount, sol };
  if (!signed(tx, wallet)) return { kind: "TRANSFER", reason: raw > 0n ? "received_not_signer" : "sent_not_signer", ...withToken };
  if (tx.programIds.length > 0 && tx.programIds.every((p) => NON_SWAP_PROGRAMS.has(p))) return { kind: "TRANSFER", reason: "no_swap_program", ...withToken };
  if (raw > 0n && sol < 0) return { kind: "BUY", reason: "token_in_sol_out", ...withToken };
  if (raw < 0n && sol > 0) return { kind: "SELL", reason: "token_out_sol_in", ...withToken };
  return { kind: "TRANSFER", reason: sol === 0 ? "no_sol_leg" : "sol_same_direction", ...withToken };
}

/** Step 4 `Trade` for a BUY/SELL, null otherwise. */
export function toTrade(tx: HistoryTx, wallet: string): Trade | null {
  const c = classifyForWallet(tx, wallet);
  if ((c.kind !== "BUY" && c.kind !== "SELL") || !c.mint || c.tokenAmount === null) return null;
  return { signature: tx.signature, slot: tx.slot, time: tx.time, owner: wallet, mint: c.mint, side: c.kind === "BUY" ? "buy" : "sell", tokenAmount: c.tokenAmount, sol: Math.abs(c.sol) };
}
