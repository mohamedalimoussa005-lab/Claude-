/**
 * Adapter: Helius "enhanced transaction" JSON → NormalizedTx.
 *
 * Written against Helius's documented schema (feePayer, fee, slot, timestamp, transactionError, nativeTransfers,
 * accountData[].nativeBalanceChange / tokenBalanceChanges[].rawTokenAmount, instructions[].programId with
 * innerInstructions). It has NOT been checked against a live raw payload (the Helius MCP only returns rendered
 * text), so it is covered by tests on documented-shape fixtures only. Known differences from the RPC reading:
 * Helius does not list signers (the fee payer is used) and does not expose account-creation rent, so the SOL quote of
 * a swap read through Helius is less precise (rent and tips are not removed). Funding transfers are exact.
 */

import type { NormalizedTx, SolTransfer, TokenDelta } from "./model.ts";
import { NormalizeError } from "./normalize.ts";

interface HeliusIx {
  programId?: string;
  innerInstructions?: HeliusIx[];
}
export interface HeliusTx {
  signature: string;
  slot: number;
  timestamp?: number | null;
  feePayer: string;
  fee: number;
  transactionError?: unknown;
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
  accountData?: {
    account: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string } }[];
  }[];
  instructions?: HeliusIx[];
}

export function normalizeHeliusTx(h: HeliusTx): NormalizedTx {
  if (!h || typeof h.signature !== "string" || !Number.isInteger(h.slot) || typeof h.feePayer !== "string") throw new NormalizeError("helius: missing signature, slot or feePayer");
  const blockTime = typeof h.timestamp === "number" ? h.timestamp : null;
  const solTransfers: SolTransfer[] = (h.nativeTransfers ?? []).map((t) => {
    if (!Number.isInteger(t.amount) || t.amount < 0) throw new NormalizeError("helius: native transfer amount");
    return { signature: h.signature, slot: h.slot, blockTime, from: t.fromUserAccount, to: t.toUserAccount, lamports: BigInt(t.amount) };
  });
  const solDeltas: Record<string, bigint> = {};
  const tokMap = new Map<string, TokenDelta>();
  for (const a of h.accountData ?? []) {
    if (a.nativeBalanceChange) solDeltas[a.account] = (solDeltas[a.account] ?? 0n) + BigInt(a.nativeBalanceChange);
    for (const t of a.tokenBalanceChanges ?? []) {
      if (!/^-?[0-9]+$/.test(t.rawTokenAmount.tokenAmount)) throw new NormalizeError("helius: token amount");
      const k = `${t.userAccount}|${t.mint}`;
      const cur = tokMap.get(k) ?? { owner: t.userAccount, mint: t.mint, delta: 0n };
      cur.delta += BigInt(t.rawTokenAmount.tokenAmount);
      tokMap.set(k, cur);
    }
  }
  const programs = new Set<string>();
  const visit = (ix: HeliusIx) => {
    if (ix.programId) programs.add(ix.programId);
    for (const i of ix.innerInstructions ?? []) visit(i);
  };
  for (const ix of h.instructions ?? []) visit(ix);
  return {
    signature: h.signature,
    slot: h.slot,
    blockTime,
    failed: h.transactionError !== null && h.transactionError !== undefined,
    feePayer: h.feePayer,
    signers: [h.feePayer],
    fee: BigInt(h.fee),
    programs: [...programs].sort(),
    solDeltas,
    tokenDeltas: [...tokMap.values()].filter((t) => t.delta !== 0n),
    solTransfers,
    rentByPayer: {},
  };
}
