/**
 * Who moved what in a transaction, kept apart: the wallet under study, the pools it traded against, and third parties
 * (a fee payer or co-signer that is not the wallet). A swap is PROVEN by relations in the data, not by an amount:
 *   - a counterparty (another token owner) moved the same token in the OPPOSITE direction, and
 *   - that counterparty received (buy) or paid out (sell) the quote asset: lamports, wrapped SOL, or a stablecoin.
 * A sender of an airdrop moves tokens the other way but receives nothing, so it is not a swap.
 */

import type { HistoryTx } from "../../history/types.ts";
import { WSOL_MINT } from "../../wallets/trades.ts";
import { STABLE_MINTS } from "./mints.ts";

export interface Counterparty {
  account: string;
  tokenRaw: string;
  lamports: number;
  wsolUi: number;
  stableUi: number;
}

export interface SwapEvidence {
  counterparties: Counterparty[];
  /** SOL the counterparties received (+) or paid out (−): lamports plus wrapped SOL. */
  paymentSol: number;
  /** Stablecoins the counterparties received (+) or paid out (−). */
  paymentUsd: number;
}

const ui = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

export function swapEvidence(tx: HistoryTx, wallet: string, mint: string, walletRaw: bigint): SwapEvidence {
  const counterparties: Counterparty[] = [];
  for (const [owner, mints] of Object.entries(tx.tokenDeltas)) {
    if (owner === wallet) continue;
    const d = mints[mint];
    if (!d) continue;
    const raw = BigInt(d.raw);
    if (raw === 0n || raw > 0n === walletRaw > 0n) continue; // not the opposite direction
    const w = mints[WSOL_MINT];
    let stable = 0;
    for (const s of STABLE_MINTS) if (mints[s]) stable += ui(mints[s].raw, mints[s].decimals);
    counterparties.push({ account: owner, tokenRaw: d.raw, lamports: tx.lamportDeltas[owner] ?? 0, wsolUi: w ? ui(w.raw, w.decimals) : 0, stableUi: stable });
  }
  return {
    counterparties,
    paymentSol: counterparties.reduce((a, c) => a + c.lamports / 1e9 + c.wsolUi, 0),
    paymentUsd: counterparties.reduce((a, c) => a + c.stableUi, 0),
  };
}

export interface ThirdParty {
  account: string;
  role: "fee_payer" | "co_signer";
  netLamports: number;
}

/** Signers other than the wallet, with what they net. */
export function thirdParties(tx: HistoryTx, wallet: string): ThirdParty[] {
  const out: ThirdParty[] = [];
  if (tx.feePayer && tx.feePayer !== wallet) out.push({ account: tx.feePayer, role: "fee_payer", netLamports: tx.lamportDeltas[tx.feePayer] ?? 0 });
  for (const s of tx.signers) if (s !== wallet && s !== tx.feePayer) out.push({ account: s, role: "co_signer", netLamports: tx.lamportDeltas[s] ?? 0 });
  return out;
}
