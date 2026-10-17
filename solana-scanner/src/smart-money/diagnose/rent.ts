/**
 * Why is the rent of a transaction STILL "uncertain" under engine v2? The facts come from the engine itself
 * (`assessRent`, `swapEvidence`): this module only adds the account-by-account picture (wallet, third parties, pools,
 * created / closed token accounts) so that each remaining case can be checked by hand. It changes nothing.
 */

import type { HistoryTx } from "../../history/types.ts";
import { swapEvidence, thirdParties } from "../ledger/evidence.ts";
import { assessRent } from "../ledger/rent.ts";
import type { Ledger, LedgerEntry } from "../ledger/types.ts";
import { ref } from "./window.ts";
import type { RentAccount, RentCase, RentCause, RentDiagnosis, RentVerdict } from "./types.ts";

/** The wallet moved ≤ 0.005 SOL (fee included). */
const MICRO_WALLET_LAMPORTS = 5_000_000;

const VERDICT_OF: Record<RentCause, RentVerdict> = {
  incomplete_signers: "signers_unavailable",
  funder_ambiguous: "wallet_deposit_unproven",
  refund_destination_ambiguous: "refund_destination_unproven",
  standard_size_account_not_wallet_ata: "unrecognised_standard_size_account",
};
const PRIORITY: RentCause[] = ["incomplete_signers", "funder_ambiguous", "refund_destination_ambiguous", "standard_size_account_not_wallet_ata"];

const NOTE: Record<RentCause, string> = {
  incomplete_signers: "décodage enrichi : les co-signataires ne sont pas listés, impossible de savoir qui a financé",
  funder_ambiguous: "un autre signataire a un solde net sortant au moins égal au dépôt : il a pu le financer à la place du wallet",
  refund_destination_ambiguous: "le compte du wallet est fermé, mais le destinataire du remboursement n'est pas prouvé (le wallet n'a pas signé, ou un autre signataire a reçu une somme équivalente)",
  standard_size_account_not_wallet_ata: "un compte au montant exact d'un loyer de compte de token a bougé, mais ce n'est PAS un compte de token associé du wallet : piste, pas preuve",
};

export function diagnoseRent(ledger: Ledger, wallet: string, bySignature: Map<string, HistoryTx>): RentDiagnosis {
  const cases: RentCase[] = [];
  const missingTx: string[] = [];
  let identified = 0;
  for (const e of ledger.entries) {
    if (e.rentStatus === "identified") identified++;
    if (e.rentStatus !== "uncertain") continue;
    const tx = bySignature.get(e.signature);
    if (!tx) {
      missingTx.push(e.signature);
      continue;
    }
    const a = assessRent(tx, wallet);
    const mint = mintOf(e);
    const pools = mint && e.kind !== "undecodable" ? swapEvidence(tx, wallet, mint, tokenSign(e)).counterparties.map((c) => ({ account: c.account, lamports: c.lamports })) : [];
    const tps = thirdParties(tx, wallet);
    const poolSet = new Set(pools.map((p) => p.account));
    const created = new Set(a.created.map((c) => c.account));
    const closed = new Set(a.closed.map((c) => c.account));
    const unattributed = new Set(a.unattributed.map((u) => u.account));
    const roleOf = (account: string): RentAccount["role"] =>
      account === wallet ? "wallet" : tx.feePayer === account ? "fee_payer" : tx.signers.includes(account) ? "co_signer" : poolSet.has(account) ? "pool" : created.has(account) ? "wallet_ata_created" : closed.has(account) ? "wallet_ata_closed" : unattributed.has(account) ? "standard_size_not_wallet_ata" : "other";
    const accounts: RentAccount[] = Object.entries(tx.lamportDeltas)
      .map(([account, lamports]) => ({ account, lamports, role: roleOf(account) }))
      .sort((x, y) => Math.abs(y.lamports) - Math.abs(x.lamports))
      .slice(0, 8);
    const causes = a.reasons as RentCause[];
    const top = PRIORITY.find((c) => causes.includes(c)) ?? causes[0];
    const walletLamports = tx.lamportDeltas[wallet] ?? 0;
    const notes = causes.map((c) => NOTE[c]);
    cases.push({
      ...ref(e),
      kind: e.kind,
      side: e.kind === "trade" ? e.side : null,
      mint,
      walletLamports,
      feeLamports: tx.feePayer === wallet ? tx.fee : 0,
      tradingSol: e.kind === "trade" && e.quote.asset === "SOL" ? e.quote.amount : null,
      swapProof: e.swapProof ?? null,
      signerCount: tx.signers.length,
      signersComplete: tx.signersComplete,
      feePayerIsWallet: tx.feePayer === wallet,
      thirdParties: tps,
      pools,
      funder: a.funder,
      causes,
      verdict: VERDICT_OF[top],
      microTrade: Math.abs(walletLamports) <= MICRO_WALLET_LAMPORTS,
      accounts,
      notes,
    });
  }
  const byCause: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const c of cases) {
    for (const k of c.causes) byCause[k] = (byCause[k] ?? 0) + 1;
    byVerdict[c.verdict] = (byVerdict[c.verdict] ?? 0) + 1;
  }
  return {
    status: missingTx.length === 0 ? "ok" : cases.length > 0 ? "partial" : "impossible",
    reason: missingTx.length ? `${missingTx.length} transaction(s) du registre absente(s) du cache : détail impossible pour elles` : undefined,
    uncertainTxs: cases.length + missingTx.length,
    identifiedTxs: identified,
    byCause,
    byVerdict,
    microTradeCases: cases.filter((c) => c.microTrade).length,
    cases,
  };
}

function mintOf(e: LedgerEntry): string | null {
  return e.kind === "undecodable" ? (e.legs[0]?.mint ?? null) : e.mint;
}
function tokenSign(e: Exclude<LedgerEntry, { kind: "undecodable" }>): bigint {
  return e.kind === "trade" ? (e.side === "buy" ? 1n : -1n) : e.direction === "in" ? 1n : -1n;
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
