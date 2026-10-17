/**
 * Before / after: the SAME cached transactions through engine v1 (frozen: phases 3 and 3.1A) and engine v2 (live), side by
 * side. Read-only and offline. Every reclassified transaction keeps its signature and carries the reason for the change.
 */

import type { HistoryTx } from "../../history/types.ts";
import type { SmartMoneyThresholds } from "../config.ts";
import { DEFAULT_THRESHOLDS } from "../config.ts";
import { txsOf } from "../diagnose/load.ts";
import type { LocalData } from "../diagnose/load.ts";
import { ref } from "../diagnose/window.ts";
import { buildLedger } from "../ledger/build.ts";
import { buildLedgerV1 } from "../ledger/legacy/buildV1.ts";
import { detectRentV1 } from "../ledger/legacy/rentV1.ts";
import { assessRent, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../ledger/rent.ts";
import type { Ledger, LedgerEntry } from "../ledger/types.ts";
import { computePnl } from "../pnl/fifo.ts";
import { profileFromPnl } from "../pnl/profile.ts";
import type { PnlResult, RoundStatus } from "../pnl/types.ts";

export const COMPARE_SCHEMA = "smart-money.compare/1" as const;

export interface ClassCounts {
  buys: number;
  sells: number;
  transfersIn: number;
  transfersOut: number;
  undecodable: number;
  ignored: number;
  rentIdentified: number;
  rentUncertain: number;
}

export interface Reclassification {
  signature: string;
  slot: number | null;
  time: number | null;
  date: string | null;
  mint: string | null;
  before: string;
  after: string;
  /** What changed: class, rent status, or the cost amount. */
  changes: ("class" | "rent" | "amount")[];
  /** Why, in the engine's own codes and in words. */
  explanation: string[];
}

export type StatusCounts = Record<RoundStatus, number>;

export interface Comparison {
  schema: typeof COMPARE_SCHEMA;
  generatedAt: string;
  readOnly: true;
  network: false;
  wallet: string;
  transactions: number;
  /** Profits are only as reliable as the history is complete. */
  reliability: { profitsReliable: boolean; historyComplete: boolean; knownFromReport: boolean; message: string };
  counts: { v1: ClassCounts; v2: ClassCounts };
  rent: { v1Uncertain: number; v2Uncertain: number; v2ByReason: Record<string, number>; resolved: number; newlyUncertain: number };
  reclassified: Reclassification[];
  positions: { v1: StatusCounts; v2: StatusCounts; orphanSalesV1: number; orphanSalesV2: number; changedTokens: { mint: string; v1: string[]; v2: string[] }[] };
  /** Indicative only: positions closed inside the window, whatever their status. */
  pnl: { v1: { indicativeSol: number; rentLockedSol: number }; v2: { indicativeSol: number; rentLockedSol: number }; note: string };
  /** Does the address derivation find the wallet's token accounts in this very data? */
  derivationCheck: { walletAtaAccountsFound: number; standardSizeNotMatched: number; confirmed: boolean | null; verdict: string };
}

const classKey = (e: LedgerEntry | undefined): string => {
  if (!e) return "absent";
  if (e.kind === "trade") return `trade:${e.side}:${e.quote.asset}`;
  if (e.kind === "transfer") return `transfer:${e.direction}:${e.reason}`;
  return `undecodable:${e.reason}`;
};
const words = (e: LedgerEntry | undefined): string => {
  if (!e) return "non retenue (aucune opération de token)";
  if (e.kind === "trade") return `${e.side === "buy" ? "achat" : "vente"} ${e.quote.amount.toFixed(6)} ${e.quote.asset === "SOL" ? "SOL" : "USD"}`;
  if (e.kind === "transfer") return `transfert ${e.direction === "in" ? "entrant" : "sortant"} (${e.reason}) — coût INCONNU`;
  return `non décodable (${e.reason})`;
};

function counts(l: Ledger): ClassCounts {
  const c: ClassCounts = { buys: 0, sells: 0, transfersIn: 0, transfersOut: 0, undecodable: 0, ignored: l.ignored.length, rentIdentified: 0, rentUncertain: 0 };
  for (const e of l.entries) {
    if (e.kind === "trade") e.side === "buy" ? c.buys++ : c.sells++;
    else if (e.kind === "transfer") e.direction === "in" ? c.transfersIn++ : c.transfersOut++;
    else c.undecodable++;
    if (e.rentStatus === "identified") c.rentIdentified++;
    if (e.rentStatus === "uncertain") c.rentUncertain++;
  }
  return c;
}

const statusCounts = (p: PnlResult): StatusCounts => {
  const s: StatusCounts = { KNOWN: 0, PARTIAL: 0, PROVISIONAL: 0, UNKNOWN: 0 };
  for (const r of p.rounds) s[r.status]++;
  return s;
};

/** What the frozen v1 rule saw, in words (the numeric band is the thing that was removed). */
function legacyWhy(tx: HistoryTx | undefined, wallet: string): string[] {
  if (!tx) return [];
  const r = detectRentV1(tx, wallet);
  if (r.status !== "uncertain") return [];
  const band = Object.entries(tx.lamportDeltas).filter(([a, d]) => a !== wallet && d >= 890_880 && d <= 3_000_000 && d !== TOKEN_ACCOUNT_RENT_LAMPORTS);
  const std = Object.entries(tx.lamportDeltas).filter(([a, d]) => a !== wallet && Math.abs(d) === TOKEN_ACCOUNT_RENT_LAMPORTS);
  const out: string[] = [];
  if (std.length === 0 && band.length > 0) out.push(`v1 : un compte (${band.map(([a, d]) => `${a.slice(0, 4)}…${a.slice(-4)} ${d >= 0 ? "+" : ""}${d} lamports`).join(", ")}) tombait dans la plage numérique 890 880–3 000 000 et était pris pour un loyer`);
  else if (std.length > 0) out.push(`v1 : loyer standard détecté, mais le wallet n'était pas le seul signataire / payeur (${tx.signers.length} signataire(s), payeur ${tx.feePayer === wallet ? "= wallet" : "≠ wallet"})`);
  return out;
}

const REASON_WORDS: Record<string, string> = {
  "micro_trade_kept": "petit montant conservé comme trade grâce à la preuve de swap",
  "wallet_side_only": "aucune preuve de contrepartie : règle côté wallet (seuils) appliquée",
  "no_counterparty": "aucune contrepartie observable dans la transaction",
  "counterparty_without_payment": "une contrepartie existe mais n'a reçu/versé aucun paiement : pas un swap",
  "counterparty_in_other_asset": "la contrepartie a bougé dans un autre actif (route) : prix côté wallet seulement",
  funder_ambiguous: "dépôt de loyer : un autre signataire a pu le financer",
  incomplete_signers: "dépôt de loyer : signataires incomplets (décodage enrichi)",
  refund_destination_ambiguous: "remboursement de loyer : destinataire non prouvé",
  standard_size_account_not_wallet_ata: "un compte au montant d'un loyer n'est pas un ATA du wallet",
};

export function compareWallet(wallet: string, local: LocalData, o: { thresholds?: SmartMoneyThresholds; tipAccounts?: string[]; now: number }): Comparison {
  const thresholds = o.thresholds ?? DEFAULT_THRESHOLDS;
  const txs = txsOf(local, wallet);
  const saved = local.reports.find((r) => r.report.wallet === wallet)?.report ?? null;
  const complete = saved?.history.complete ?? false;
  const bySig = new Map(txs.map((t) => [t.signature, t]));

  const l1 = buildLedgerV1(wallet, txs, { thresholds, tipAccounts: o.tipAccounts });
  const l2 = buildLedger(wallet, txs, { thresholds, tipAccounts: o.tipAccounts });
  const coverage = { complete, oldestTime: txs.map((t) => t.time).filter((t): t is number => t !== null).sort((a, b) => a - b)[0] ?? null };
  const p1 = computePnl(l1, { coverage, thresholds });
  const p2 = computePnl(l2, { coverage, thresholds });

  const m1 = new Map(l1.entries.map((e) => [e.signature, e]));
  const m2 = new Map(l2.entries.map((e) => [e.signature, e]));
  const reclassified: Reclassification[] = [];
  let resolved = 0;
  let newlyUncertain = 0;
  for (const sig of new Set([...m1.keys(), ...m2.keys()])) {
    const a = m1.get(sig);
    const b = m2.get(sig);
    const changes: Reclassification["changes"] = [];
    if (classKey(a) !== classKey(b)) changes.push("class");
    if ((a?.rentStatus ?? "none") !== (b?.rentStatus ?? "none")) changes.push("rent");
    if (a?.kind === "trade" && b?.kind === "trade" && Math.abs(a.quote.amount - b.quote.amount) > 1e-9) changes.push("amount");
    if (a?.rentStatus === "uncertain" && b?.rentStatus !== "uncertain") resolved++;
    if (a?.rentStatus !== "uncertain" && b?.rentStatus === "uncertain") newlyUncertain++;
    if (changes.length === 0) continue;
    const tx = bySig.get(sig);
    const e = (b ?? a)!;
    const explanation: string[] = [...legacyWhy(tx, wallet)];
    if (b) {
      for (const r of [...(b.reasons ?? []), ...(b.rentReasons ?? [])]) if (REASON_WORDS[r]) explanation.push(`v2 : ${REASON_WORDS[r]}`);
      {
        const ev = b.kind === "trade" && b.poolSideAmount != null ? ` (la contrepartie a ${b.side === "buy" ? "reçu" : "versé"} ${b.poolSideAmount.toFixed(6)})` : "";
        if (b.swapProof === "counterparty_payment") explanation.push(`v2 : swap prouvé par la contrepartie${ev}`);
      }
      if (b.rentStatus === "identified" && (b.rentDepositLamports || b.rentRefundLamports || b.thirdPartyRentLamports)) explanation.push(`v2 : loyer prouvé (compte de token associé du wallet) — dépôt ${b.rentDepositLamports}, remboursement ${b.rentRefundLamports}, dépôt tiers ${b.thirdPartyRentLamports ?? 0} lamports`);
    }
    if (explanation.length === 0) explanation.push("changement de comptabilité sans motif spécifique (voir les codes de raison)");
    reclassified.push({ ...ref(e), mint: e.kind === "undecodable" ? (e.legs[0]?.mint ?? null) : e.mint, before: words(a), after: words(b), changes, explanation });
  }
  reclassified.sort((x, y) => (x.time ?? 0) - (y.time ?? 0));

  const orphan = (p: PnlResult) => p.rounds.filter((r) => r.unknownReasons.includes("sell_without_known_buy")).length;
  const byMint = (p: PnlResult) => {
    const m = new Map<string, string[]>();
    for (const r of p.rounds) (m.get(r.mint) ?? m.set(r.mint, []).get(r.mint)!).push(r.status);
    for (const op of p.open) (m.get(op.mint) ?? m.set(op.mint, []).get(op.mint)!).push(`OPEN${op.hasUnknownLots || op.unknownReasons.length ? " (coût inconnu)" : op.knownCost !== null ? " (coût connu)" : ""}`);
    return m;
  };
  const q1 = byMint(p1);
  const q2 = byMint(p2);
  const changedTokens = [...new Set([...q1.keys(), ...q2.keys()])]
    .map((mint) => ({ mint, v1: (q1.get(mint) ?? []).sort(), v2: (q2.get(mint) ?? []).sort() }))
    .filter((x) => x.v1.join() !== x.v2.join());

  const indicative = (p: PnlResult) => p.rounds.filter((r) => r.quote === "SOL" && r.pnl !== null).reduce((a, r) => a + (r.pnl as number), 0);
  const locked = (p: PnlResult) => profileFromPnl(p, { thresholds }).costs.rentNetLockedSol;

  // Self-check of the derivation on this very data.
  let found = 0;
  let unmatched = 0;
  for (const t of txs) {
    const a = assessRent(t, wallet);
    found += a.created.length + a.closed.length;
    unmatched += a.unattributed.length;
  }
  const confirmed = found > 0 ? true : unmatched > 0 ? false : null;
  const verdict = confirmed === true ? `confirmée : ${found} création(s)/fermeture(s) rattachée(s) aux comptes de token associés du wallet par dérivation d'adresse` : confirmed === false ? `NON CONFIRMÉE : aucun compte de loyer ne correspond à une adresse dérivée alors que ${unmatched} compte(s) de taille standard existent — ne pas se fier au rent « identifié » avant vérification (le moteur reste prudent : ces cas sont « incertains »)` : "sans objet : aucun mouvement de loyer observé dans ces données";

  const knownFromReport = !!saved;
  const reliable = complete;
  return {
    schema: COMPARE_SCHEMA,
    generatedAt: new Date(o.now).toISOString(),
    readOnly: true,
    network: false,
    wallet,
    transactions: txs.length,
    reliability: {
      profitsReliable: reliable,
      historyComplete: complete,
      knownFromReport,
      message: reliable ? "Historique complet : les positions KNOWN peuvent être lues comme des résultats." : knownFromReport ? "PnL NON FIABLE : l'historique est tronqué — aucun profit n'est affirmé, les chiffres ci-dessous sont indicatifs." : "PnL NON FIABLE : aucun rapport enregistré, la complétude de l'historique est inconnue (traitée comme tronquée) — aucun profit n'est affirmé, les chiffres ci-dessous sont indicatifs.",
    },
    counts: { v1: counts(l1), v2: counts(l2) },
    rent: { v1Uncertain: counts(l1).rentUncertain, v2Uncertain: counts(l2).rentUncertain, v2ByReason: reasonCounts(l2), resolved, newlyUncertain },
    reclassified,
    positions: { v1: statusCounts(p1), v2: statusCounts(p2), orphanSalesV1: orphan(p1), orphanSalesV2: orphan(p2), changedTokens },
    pnl: { v1: { indicativeSol: indicative(p1), rentLockedSol: locked(p1) }, v2: { indicativeSol: indicative(p2), rentLockedSol: locked(p2) }, note: "Somme des résultats des positions fermées dans la fenêtre, quel que soit leur statut. Ce n'est PAS un profit : l'historique ne remonte pas au début du wallet." },
    derivationCheck: { walletAtaAccountsFound: found, standardSizeNotMatched: unmatched, confirmed, verdict },
  };
}

function reasonCounts(l: Ledger): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of l.entries) for (const r of e.rentReasons ?? []) out[r] = (out[r] ?? 0) + 1;
  return out;
}
