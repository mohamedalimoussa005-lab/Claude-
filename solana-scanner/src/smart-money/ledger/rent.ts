/**
 * Rent (account deposit) accounting, engine v2: a deposit is attributed from RELATIONS between accounts, never from a
 * lamport amount alone.
 *
 *  - CREATED / CLOSED: an account counts only if its address IS one of the wallet's associated token accounts for a mint
 *    that appears in the transaction (derived offline, SPL Token and Token-2022). Its own lamport delta is then the rent
 *    (for a native-SOL account the wrapped balance is taken out).
 *  - WHO PAID: a deposit is the wallet's only if the wallet signed and no other signer could have paid it (their net
 *    outflow, fee excluded, is smaller than the deposit). A wallet that did not sign did not pay.
 *  - Pools and fee recipients are never read as rent: they are counterparties (see evidence.ts).
 *  - An account with exactly the standard rent that is NOT a wallet token account (while the token / ATA programs ran) is
 *    left "uncertain": it is a lead, not a proof. No numeric range is used.
 * Anything not proven stays "uncertain", and the position becomes PARTIAL instead of getting a misleading PnL.
 */

import type { HistoryTx } from "../../history/types.ts";
import { WSOL_MINT } from "../../wallets/trades.ts";
import { ATA_PROGRAM_ID, deriveAta, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana/pda.ts";

export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
export const ATA_PROGRAM = ATA_PROGRAM_ID;

export type RentStatus = "none" | "identified" | "uncertain";

export type RentReason =
  | "incomplete_signers"
  | "funder_ambiguous"
  | "refund_destination_ambiguous"
  | "standard_size_account_not_wallet_ata";

export interface RentFact {
  account: string;
  mint: string;
  program: "spl" | "token2022";
  /** The rent part of the account's lamport movement (the wrapped-SOL balance is taken out). */
  rentLamports: number;
}

export interface RentAssessment {
  status: RentStatus;
  /** Deposited by the wallet into accounts created here (proven). */
  depositLamports: number;
  /** Returned to the wallet by accounts closed here (proven). */
  refundLamports: number;
  /** Deposited by someone else (the wallet did not sign): outside the wallet's cash flow. */
  thirdPartyDepositLamports: number;
  created: RentFact[];
  closed: RentFact[];
  /** Standard-size accounts that are not the wallet's own token accounts. */
  unattributed: { account: string; lamports: number }[];
  funder: "wallet" | "third_party" | "unknown" | null;
  reasons: RentReason[];
}

const PROGRAMS = [
  { id: TOKEN_PROGRAM_ID, name: "spl" as const },
  { id: TOKEN_2022_PROGRAM_ID, name: "token2022" as const },
];

export function assessRent(tx: HistoryTx, wallet: string): RentAssessment {
  const owners = new Set(Object.keys(tx.tokenDeltas));
  const signers = new Set(tx.signers);
  const mints = new Set<string>([WSOL_MINT]);
  for (const m of Object.values(tx.tokenDeltas)) for (const mint of Object.keys(m)) mints.add(mint);
  const mine = new Map<string, { mint: string; program: "spl" | "token2022" }>();
  for (const mint of mints) for (const p of PROGRAMS) mine.set(deriveAta(wallet, mint, p.id), { mint, program: p.name });
  const walletWsol = Number(BigInt(tx.tokenDeltas[wallet]?.[WSOL_MINT]?.raw ?? "0"));
  const tokenProgramRan = tx.programIds.some((p) => p === TOKEN_PROGRAM_ID || p === TOKEN_2022_PROGRAM_ID || p === ATA_PROGRAM_ID);

  const created: RentFact[] = [];
  const closed: RentFact[] = [];
  const unattributed: RentAssessment["unattributed"] = [];
  for (const [account, delta] of Object.entries(tx.lamportDeltas)) {
    if (account === wallet) continue;
    const own = mine.get(account);
    if (own) {
      // A native-SOL account also carries the wrapped balance: only the rest is rent.
      const rent = own.mint === WSOL_MINT && Math.sign(delta) === Math.sign(walletWsol) ? delta - walletWsol : delta;
      if (rent > 0) created.push({ account, ...own, rentLamports: rent });
      else if (rent < 0) closed.push({ account, ...own, rentLamports: -rent });
    } else if (Math.abs(delta) === TOKEN_ACCOUNT_RENT_LAMPORTS && tokenProgramRan && !owners.has(account) && !signers.has(account)) {
      unattributed.push({ account, lamports: delta });
    }
  }

  const reasons = new Set<RentReason>();
  if (unattributed.length > 0) reasons.add("standard_size_account_not_wallet_ata");

  const deposit = created.reduce((a, c) => a + c.rentLamports, 0);
  const refund = closed.reduce((a, c) => a + c.rentLamports, 0);
  const others = tx.signers.filter((s) => s !== wallet);
  const outflowOf = (s: string) => Math.max(0, -(tx.lamportDeltas[s] ?? 0) - (s === tx.feePayer ? tx.fee : 0));
  const inflowOf = (s: string) => Math.max(0, (tx.lamportDeltas[s] ?? 0) + (s === tx.feePayer ? tx.fee : 0));

  let funder: RentAssessment["funder"] = null;
  if (created.length > 0) {
    if (!tx.signersComplete) {
      funder = "unknown";
      reasons.add("incomplete_signers");
    } else if (!signers.has(wallet)) funder = "third_party";
    else if (others.reduce((a, s) => a + outflowOf(s), 0) >= deposit) {
      funder = "unknown";
      reasons.add("funder_ambiguous");
    } else funder = "wallet";
  }

  let refundProven = true;
  if (closed.length > 0) {
    if (!tx.signersComplete) {
      refundProven = false;
      reasons.add("incomplete_signers");
    } else if (!signers.has(wallet) || others.some((s) => inflowOf(s) >= Math.min(...closed.map((c) => c.rentLamports)))) {
      refundProven = false;
      reasons.add("refund_destination_ambiguous");
    }
  }

  const depositLamports = funder === "wallet" ? deposit : 0;
  const refundLamports = refundProven ? refund : 0;
  const found = created.length > 0 || closed.length > 0;
  const status: RentStatus = reasons.size > 0 ? "uncertain" : found ? "identified" : "none";
  return {
    status,
    depositLamports,
    refundLamports,
    thirdPartyDepositLamports: funder === "third_party" ? deposit : 0,
    created,
    closed,
    unattributed,
    funder,
    reasons: [...reasons],
  };
}
