/**
 * Rent (account deposit) accounting, separated from trading.
 *
 * What the data lets us identify: a standard SPL token account holds exactly
 * 2,039,280 lamports (165 bytes, rent-exempt). An account other than the
 * wallet whose lamports rose by exactly that amount was CREATED in this
 * transaction; one that fell by exactly that amount was CLOSED.
 *
 * Who paid / received it is only certain when the wallet is the only signer
 * and the fee payer (nobody else can fund a system account or authorise a
 * close). Anything else, and every rent-like movement that is not the
 * standard amount while an ATA instruction ran (Token-2022 extensions…), is
 * "uncertain": the amounts stay inside the trade and the position becomes
 * PARTIAL instead of getting a misleading PnL.
 *
 * Known blind spot: closing a non-standard (Token-2022) account with no ATA
 * instruction in the transaction leaves no trace in lamportDeltas we can tie
 * to rent; it cannot be detected.
 */

import type { HistoryTx } from "../../history/types.ts";

export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Rent of a 0-byte account up to a token account with extensions: the band where a non-standard rent could hide. */
const RENT_BAND: [number, number] = [890_880, 3_000_000];

export type RentStatus = "none" | "identified" | "uncertain";

export interface RentMovement {
  /** Lamports the wallet deposited into new accounts (identified only). */
  depositLamports: number;
  /** Lamports the wallet got back from closed accounts (identified only). */
  refundLamports: number;
  status: RentStatus;
}

export function detectRent(tx: HistoryTx, wallet: string): RentMovement {
  let created = 0;
  let closed = 0;
  let nonStandardRentLike = false;
  for (const [account, delta] of Object.entries(tx.lamportDeltas)) {
    if (account === wallet) continue;
    if (delta === TOKEN_ACCOUNT_RENT_LAMPORTS) created++;
    else if (delta === -TOKEN_ACCOUNT_RENT_LAMPORTS) closed++;
    else if (delta >= RENT_BAND[0] && delta <= RENT_BAND[1]) nonStandardRentLike = true;
  }
  const ataRan = tx.programIds.includes(ATA_PROGRAM);
  if (created === 0 && closed === 0) return { depositLamports: 0, refundLamports: 0, status: ataRan && nonStandardRentLike ? "uncertain" : "none" };
  const selfFunded = tx.signersComplete && tx.signers.length === 1 && tx.signers[0] === wallet && tx.feePayer === wallet;
  if (!selfFunded || (ataRan && nonStandardRentLike)) return { depositLamports: 0, refundLamports: 0, status: "uncertain" };
  return { depositLamports: created * TOKEN_ACCOUNT_RENT_LAMPORTS, refundLamports: closed * TOKEN_ACCOUNT_RENT_LAMPORTS, status: "identified" };
}
