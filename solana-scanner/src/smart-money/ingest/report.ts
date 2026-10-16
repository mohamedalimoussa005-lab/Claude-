/** One wallet analysis report: what was fetched, what was reconstructed, what is known / partial / unknown, and the evidence. */

import type { Ledger } from "../ledger/types.ts";
import type { WalletPnlProfile } from "../pnl/profile.ts";
import type { PnlResult } from "../pnl/types.ts";
import { formatProfile } from "../pnl/format.ts";
import type { BudgetReport } from "./budget.ts";
import type { IngestStop, WalletIngest } from "./ingest.ts";

export type ReportSource = "live" | "offline" | "demo";

export interface WalletReport {
  wallet: string;
  source: ReportSource;
  history: Omit<WalletIngest, "txs" | "wallet">;
  transactions: { used: number; ignored: Record<string, number> };
  trades: { buys: number; sells: number; transfersIn: number; transfersOut: number; undecodable: number; undecodableByReason: Record<string, number> };
  pnl: { known: number; partial: number; provisional: number; unknown: number; open: number };
  profile: WalletPnlProfile;
  /** The signatures every figure rests on. */
  evidence: {
    signaturesUsed: number;
    rounds: { mint: string; status: string; signatures: string[] }[];
    open: { mint: string; signatures: string[] }[];
  };
  /** No wallet is labelled at this stage. */
  label: null;
  budget: BudgetReport | null;
  /** Which transport answered (labels and counters, never an endpoint). */
  transport: string | null;
}

const count = <T>(xs: T[], key: (x: T) => string): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const x of xs) o[key(x)] = (o[key(x)] ?? 0) + 1;
  return o;
};

export function buildReport(i: { ingest: WalletIngest; ledger: Ledger; pnl: PnlResult; profile: WalletPnlProfile; source: ReportSource; budget: BudgetReport | null; transport?: string | null }): WalletReport {
  const { txs, wallet, ...history } = i.ingest;
  const e = i.ledger.entries;
  const undecodable = e.filter((x) => x.kind === "undecodable");
  return {
    wallet,
    source: i.source,
    history,
    transactions: { used: txs.length, ignored: count(i.ledger.ignored, (x) => x.reason) },
    trades: {
      buys: e.filter((x) => x.kind === "trade" && x.side === "buy").length,
      sells: e.filter((x) => x.kind === "trade" && x.side === "sell").length,
      transfersIn: e.filter((x) => x.kind === "transfer" && x.direction === "in").length,
      transfersOut: e.filter((x) => x.kind === "transfer" && x.direction === "out").length,
      undecodable: undecodable.length,
      undecodableByReason: count(undecodable, (x) => (x.kind === "undecodable" ? x.reason : "")),
    },
    pnl: { known: i.profile.counts.known, partial: i.profile.counts.partial, provisional: i.profile.counts.provisional, unknown: i.profile.counts.unknown, open: i.profile.counts.open },
    profile: i.profile,
    evidence: {
      signaturesUsed: new Set([...i.pnl.rounds.flatMap((r) => r.signatures), ...i.pnl.open.flatMap((o) => o.signatures)]).size,
      rounds: i.pnl.rounds.map((r) => ({ mint: r.mint, status: r.status, signatures: r.signatures })),
      open: i.pnl.open.map((o) => ({ mint: o.mint, signatures: o.signatures })),
    },
    label: null,
    budget: i.budget,
    transport: i.transport || null,
  };
}

const STOP_TEXT: Record<IngestStop, string> = {
  end_of_history: "fin de l'historique atteinte",
  max_pages: "arrêt : nombre de pages maximal atteint",
  max_transactions: "arrêt : nombre de transactions maximal atteint",
  budget_exhausted: "arrêt : budget d'appels / crédits épuisé",
  error: "arrêt : erreur du fournisseur",
  stalled: "arrêt : pagination bloquée",
  missing_transactions: "fin atteinte mais des transactions listées sont introuvables",
  source_not_guaranteed: "fin de la source atteinte, mais elle n'est pas garantie complète",
};

export function formatReport(r: WalletReport): string {
  const h = r.history;
  const L: string[] = [];
  L.push(`══ Wallet ${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)} · source ${r.source === "live" ? "RÉELLE (réseau)" : r.source === "demo" ? "DÉMO fictive" : "fichier hors-ligne"} ══`);
  L.push(`Historique : ${h.complete ? "COMPLET" : "TRONQUÉ / INCOMPLET"} — ${STOP_TEXT[h.stopReason]}`);
  L.push(`Transactions : ${h.listed} listées · ${h.downloaded} téléchargées · ${h.fromCache} depuis le cache · ${r.transactions.used} retenues pour l'analyse · ${h.missing} introuvables · échouées ignorées ${h.failedSkipped === null ? "(filtrées par le fournisseur)" : h.failedSkipped}`);
  L.push(`Pages : ${h.pages} · appels fournisseur ${h.providerCalls} · fournisseurs ${h.providers.join(", ") || "aucun"}`);
  const t = r.trades;
  L.push(`Trades reconstruits : ${t.buys + t.sells} (${t.buys} achats, ${t.sells} ventes) · transferts ${t.transfersIn} entrants / ${t.transfersOut} sortants · non décodables ${t.undecodable}${t.undecodable ? ` (${Object.entries(t.undecodableByReason).map(([k, v]) => `${k}×${v}`).join(", ")})` : ""}`);
  const p = r.pnl;
  L.push(`PnL — positions fermées : ${p.known} CONNUES · ${p.partial} PARTIELLES · ${p.provisional} PROVISOIRES · ${p.unknown} INCONNUES · (${p.open} ouvertes, non valorisées)`);
  L.push(formatProfile(r.profile));
  if (h.notes.length) L.push(...h.notes.map((n) => `! ${n}`));
  if (h.failureKinds.length) L.push(`! échecs fournisseur : ${h.failureKinds.join(", ")}`);
  L.push(`Preuves : ${r.evidence.signaturesUsed} signatures de transactions rattachées aux positions`);
  if (r.budget) L.push(`Budget : ${r.budget.calls}/${r.budget.limits.maxCalls} appels · ~${r.budget.credits}/${r.budget.limits.maxCredits} crédits estimés${r.budget.exhaustedBy ? ` · ÉPUISÉ (${r.budget.exhaustedBy})` : ""}${r.budget.refusedByPolicy ? ` · ${r.budget.refusedByPolicy} requête(s) refusée(s) par la liste blanche` : ""}`);
  if (r.transport) L.push(`Transport : ${r.transport}`);
  L.push("Étiquette : aucune (phase 3 : collecte et PnL uniquement, aucun wallet n'est qualifié).");
  return L.join("\n");
}
