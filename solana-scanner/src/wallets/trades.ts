/**
 * Decodes buys and sells from a parsed transaction using only balance
 * changes (pre/post token balances and lamports), independent of which DEX or
 * router was used. A trade is recorded only when it is unambiguous:
 *   - the owner's balance of exactly one non-SOL token changed, and
 *   - its SOL (lamports + wrapped SOL) moved in the opposite direction.
 * Anything else (transfers, multi-token routes, USDC-quoted swaps) is
 * reported as undecodable rather than guessed.
 */

import type { ParsedTransaction } from "../onchain/rpc.ts";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface Trade {
  signature: string;
  slot: number | null;
  time: number | null;
  owner: string;
  mint: string;
  side: "buy" | "sell";
  /** Token amount in UI units. */
  tokenAmount: number;
  /** SOL paid (buy) or received (sell), network fees included. */
  sol: number;
}

export type DecodeResult = { ok: true; trade: Trade } | { ok: false; reason: "no_change" | "transfer" | "multi_token" | "no_sol_leg" };

interface TokenDelta {
  raw: bigint;
  decimals: number;
}

export function tokenDeltasByOwner(tx: ParsedTransaction): Map<string, Map<string, TokenDelta>> {
  const out = new Map<string, Map<string, TokenDelta>>();
  const add = (owner: string | undefined, mint: string, raw: bigint, decimals: number) => {
    if (!owner) return;
    const m = out.get(owner) ?? new Map<string, TokenDelta>();
    const cur = m.get(mint) ?? { raw: 0n, decimals };
    m.set(mint, { raw: cur.raw + raw, decimals });
    out.set(owner, m);
  };
  for (const b of tx.meta?.preTokenBalances ?? []) add(b.owner, b.mint, -BigInt(b.uiTokenAmount.amount), b.uiTokenAmount.decimals);
  for (const b of tx.meta?.postTokenBalances ?? []) add(b.owner, b.mint, BigInt(b.uiTokenAmount.amount), b.uiTokenAmount.decimals);
  return out;
}

/** Net SOL change of an owner (native lamports + wrapped SOL), in SOL. */
export function solFlow(tx: ParsedTransaction, owner: string, deltas = tokenDeltasByOwner(tx)): number {
  let lamports = 0;
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === owner);
  if (i >= 0 && tx.meta) lamports = tx.meta.postBalances[i] - tx.meta.preBalances[i];
  const wsol = deltas.get(owner)?.get(WSOL_MINT);
  return lamports / 1e9 + (wsol ? Number(wsol.raw) / 10 ** wsol.decimals : 0);
}

/** The trade `owner` made in `tx`, restricted to `mint` when given. */
export function decodeTrade(tx: ParsedTransaction, owner: string, mint?: string): DecodeResult {
  const deltas = tokenDeltasByOwner(tx);
  const mine = [...(deltas.get(owner) ?? new Map<string, TokenDelta>())].filter(([m, d]) => m !== WSOL_MINT && d.raw !== 0n);
  if (mine.length === 0) return { ok: false, reason: "no_change" };
  if (mine.length > 1) return { ok: false, reason: "multi_token" };
  const [tokenMint, d] = mine[0];
  if (mint && tokenMint !== mint) return { ok: false, reason: "no_change" };
  const sol = solFlow(tx, owner, deltas);
  const side = d.raw > 0n ? "buy" : "sell";
  // A buy must cost SOL and a sell must bring SOL; otherwise it's a transfer (or a non-SOL quote).
  if ((side === "buy" && sol >= 0) || (side === "sell" && sol <= 0)) return { ok: false, reason: sol === 0 ? "no_sol_leg" : "transfer" };
  return {
    ok: true,
    trade: {
      signature: tx.transaction.signatures[0],
      slot: tx.slot ?? null,
      time: tx.blockTime ? tx.blockTime * 1000 : null,
      owner,
      mint: tokenMint,
      side,
      tokenAmount: Math.abs(Number(d.raw)) / 10 ** d.decimals,
      sol: Math.abs(sol),
    },
  };
}

/** Every owner whose balance of `mint` changed in `tx` (candidates for decodeTrade). */
export function ownersTouching(tx: ParsedTransaction, mint: string): string[] {
  const out: string[] = [];
  for (const [owner, m] of tokenDeltasByOwner(tx)) if ((m.get(mint)?.raw ?? 0n) !== 0n) out.push(owner);
  return out;
}
