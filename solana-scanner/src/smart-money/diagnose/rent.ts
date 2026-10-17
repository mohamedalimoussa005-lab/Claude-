/**
 * Why was the rent of a transaction left "uncertain"? This re-reads the SAME rules as ledger/rent.ts `detectRent` but
 * names the branch that fired, with the evidence (signers, fee payer, accounts and their SOL movements). It changes
 * nothing in the accounting. `explainRent(...).status` is tested to equal `detectRent(...).status`.
 */

import type { HistoryTx } from "../../history/types.ts";
import { ATA_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../ledger/rent.ts";
import type { RentStatus } from "../ledger/rent.ts";
import type { Ledger } from "../ledger/types.ts";
import { ref } from "./window.ts";
import type { RentAccount, RentCase, RentCause, RentDiagnosis, RentVerdict } from "./types.ts";

const BAND: [number, number] = [890_880, 3_000_000];
/**
 * Under ~3 mSOL traded, a pool account's own SOL delta falls in the rent-like band. A wallet that moved less than
 * this many lamports (fee included) is called a micro trade, whatever the ledger made of it.
 */
const MICRO_WALLET_LAMPORTS = 5_000_000;

export interface RentExplanation {
  status: RentStatus;
  causes: RentCause[];
  standardCreated: number;
  standardClosed: number;
  band: { account: string; lamports: number }[];
  ataProgramRan: boolean;
  selfFunded: boolean;
}

export function explainRent(tx: HistoryTx, wallet: string): RentExplanation {
  let created = 0;
  let closed = 0;
  const band: RentExplanation["band"] = [];
  for (const [account, delta] of Object.entries(tx.lamportDeltas)) {
    if (account === wallet) continue;
    if (delta === TOKEN_ACCOUNT_RENT_LAMPORTS) created++;
    else if (delta === -TOKEN_ACCOUNT_RENT_LAMPORTS) closed++;
    else if (delta >= BAND[0] && delta <= BAND[1]) band.push({ account, lamports: delta });
  }
  const ata = tx.programIds.includes(ATA_PROGRAM);
  const selfFunded = tx.signersComplete && tx.signers.length === 1 && tx.signers[0] === wallet && tx.feePayer === wallet;
  const base = { standardCreated: created, standardClosed: closed, band, ataProgramRan: ata, selfFunded };
  if (created === 0 && closed === 0) {
    return ata && band.length > 0 ? { ...base, status: "uncertain", causes: ["non_standard_rent_like_with_ata"] } : { ...base, status: "none", causes: [] };
  }
  const causes: RentCause[] = [];
  if (!selfFunded) {
    if (tx.feePayer !== wallet) causes.push("sponsored_fee_payer");
    if (!tx.signersComplete) causes.push("incomplete_signers");
    if (tx.signersComplete && tx.signers.length !== 1) causes.push("co_signer");
    return { ...base, status: "uncertain", causes };
  }
  if (ata && band.length > 0) return { ...base, status: "uncertain", causes: ["non_standard_rent_like_with_ata"] };
  return { ...base, status: "identified", causes: [] };
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

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
    const x = explainRent(tx, wallet);
    const tokenOwners = new Set(Object.keys(tx.tokenDeltas));
    const coSigners = tx.signers.filter((s) => s !== wallet).map((account) => ({ account, netLamports: tx.lamportDeltas[account] ?? 0 }));
    const tradingSol = e.kind === "trade" && e.quote.asset === "SOL" ? e.quote.amount : null;
    const walletLamports = tx.lamportDeltas[wallet] ?? 0;
    const micro = Math.abs(walletLamports) <= MICRO_WALLET_LAMPORTS;
    const notes: string[] = [];

    // Counterparty test for rent-like accounts: a pool / bonding curve owns tokens that moved and its SOL moves with the trade.
    if (micro && e.kind === "transfer" && walletLamports < 0) notes.push("classé « transfert entrant » (SOL sous le seuil de bruit de 0,005) alors qu'il s'agit peut-être d'un micro-achat : son coût est aujourd'hui INCONNU");
    const counterparty = (b: { account: string; lamports: number }) => tokenOwners.has(b.account) || (tradingSol !== null && Math.abs(Math.abs(b.lamports) - tradingSol * 1e9) <= Math.max(10_000, tradingSol * 1e9 * 0.02));
    let verdict: RentVerdict = "undetermined";
    if (x.causes.includes("non_standard_rent_like_with_ata")) {
      const cp = x.band.filter(counterparty);
      if (cp.length === x.band.length) {
        verdict = "likely_false_positive_counterparty";
        notes.push("le compte « proche d'un loyer » possède aussi un solde de token qui a bougé, ou son delta SOL égale le montant du trade : contrepartie (pool / courbe), pas un compte créé");
      } else {
        verdict = "likely_real_account_event";
        notes.push("compte de taille non standard (ex. Token-2022) sans lien avec la contrepartie : création ou fermeture réelle probable");
      }
    } else if (x.causes.length > 0) {
      verdict = "funding_unattributed";
      if (coSigners.length > 0) notes.push(coSigners.every((c) => c.netLamports === 0) ? "co-signataire(s) sans solde net : clé temporaire probable (compte jetable), le financement par le wallet est plausible mais non prouvé" : "co-signataire(s) avec solde net non nul : un tiers a pu financer ou recevoir");
      if (tx.feePayer !== wallet) notes.push("frais payés par un autre compte");
      if (!tx.signersComplete) notes.push("signataires incomplets (décodage enrichi) : impossible de savoir qui a signé");
    }

    const accounts: RentAccount[] = Object.entries(tx.lamportDeltas)
      .map(([account, lamports]) => {
        const role: RentAccount["role"] =
          account === wallet ? "wallet" : tx.feePayer === account ? "fee_payer" : tx.signers.includes(account) ? "co_signer" : lamports === TOKEN_ACCOUNT_RENT_LAMPORTS ? "standard_rent_created" : lamports === -TOKEN_ACCOUNT_RENT_LAMPORTS ? "standard_rent_closed" : x.band.some((b) => b.account === account) ? "rent_like_band" : "other";
        return { account, lamports, role, isTokenOwner: account !== wallet && tokenOwners.has(account) };
      })
      .sort((a, b) => Math.abs(b.lamports) - Math.abs(a.lamports))
      .slice(0, 8);

    cases.push({
      ...ref(e),
      kind: e.kind,
      side: e.kind === "trade" ? e.side : null,
      mint: e.kind === "undecodable" ? (e.legs[0]?.mint ?? null) : e.mint,
      walletLamports,
      feeLamports: tx.feePayer === wallet ? tx.fee : 0,
      tradingSol,
      signerCount: tx.signers.length,
      signersComplete: tx.signersComplete,
      feePayerIsWallet: tx.feePayer === wallet,
      coSigners,
      ataProgramRan: x.ataProgramRan,
      standardCreated: x.standardCreated,
      standardClosed: x.standardClosed,
      causes: x.causes,
      verdict,
      microTrade: micro,
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
export { short };
