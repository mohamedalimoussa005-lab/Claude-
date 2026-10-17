import { short } from "./rent.ts";
import type { DiagnosticReport, OrphanGroup } from "./types.ts";

const d = (s: string | null) => s ?? "inconnue";
const n = (x: number, k = 4) => (Math.abs(x) >= 1000 ? x.toFixed(0) : x.toFixed(k).replace(/\.?0+$/, ""));
const sol = (l: number) => `${(l / 1e9).toFixed(6)} SOL`;
const CAT: Record<OrphanGroup["category"], string> = {
  pre_window: "achat antérieur à la fenêtre",
  order_ambiguity: "AMBIGUÏTÉ D'ORDRE (achat dans le même slot, placé après)",
  partial_inventory: "inventaire partiel (achat en fenêtre insuffisant)",
  rounding: "arrondi",
};
const VERDICT = {
  signers_unavailable: "signataires indisponibles",
  wallet_deposit_unproven: "dépôt du wallet non prouvé",
  refund_destination_unproven: "remboursement non prouvé",
  unrecognised_standard_size_account: "compte de loyer inconnu (pas un ATA du wallet)",
} as const;
const CAUSE = { incomplete_signers: "signataires incomplets", funder_ambiguous: "financeur ambigu", refund_destination_ambiguous: "destinataire du remboursement ambigu", standard_size_account_not_wallet_ata: "montant de loyer sur un compte qui n'est pas un ATA du wallet" } as const;

export function formatDiagnostic(r: DiagnosticReport, o: { all?: boolean } = {}): string {
  const lim = (xs: unknown[]) => (o.all ? xs.length : Math.min(xs.length, 12));
  const L: string[] = [];
  L.push(`══ DIAGNOSTIC HORS-LIGNE — wallet ${short(r.wallet)} ══  (lecture seule · aucun réseau · aucun fichier modifié)`);
  const s = r.sources;
  L.push(`Sources : cache ${s.cache.present ? `${s.cache.txsInCache} tx (${s.cache.txsForWallet} pour ce wallet)` : "ABSENT"} · rapport ${s.report.present ? `${s.report.name} (écrit ${d(s.report.writtenAt)})` : "ABSENT"}`);
  for (const p of s.problems) L.push(`  ! ${p}`);

  const w = r.window;
  L.push("", "1. FENÊTRE D'HISTORIQUE COLLECTÉE");
  if (w.status === "impossible") L.push(`  IMPOSSIBLE : ${w.reason}`);
  else {
    L.push(`  Début : ${d(w.oldest?.date ?? null)} (slot ${w.oldest?.slot ?? "?"}, ${short(w.oldest?.signature ?? "????????")})`);
    L.push(`  Fin   : ${d(w.newest?.date ?? null)} (slot ${w.newest?.slot ?? "?"}, ${short(w.newest?.signature ?? "????????")})`);
    L.push(`  ${w.txCount} transactions sur ${w.spanDays === null ? "?" : w.spanDays.toFixed(2)} jours (${w.txPerDay === null ? "rythme inconnu" : `${w.txPerDay.toFixed(0)} tx/jour`})`);
    for (const a of w.absent) L.push(`  ABSENT : ${a}`);
  }

  const c = r.reconciliation;
  L.push("", "2. RÉCONCILIATION DES TRANSACTIONS");
  if (c.status === "impossible") L.push(`  IMPOSSIBLE : ${c.reason}`);
  else {
    for (const row of c.rows) L.push(`  ${row.label.padEnd(36)} ${row.value ?? "inconnu"}`);
    if (c.budget && c.budget.reportedCalls !== null) L.push(`  budget : ${c.budget.reportedCalls} appels ; attendu ${c.budget.expectedIfFailedNotRequested ?? "n/a"} si les échouées ne sont pas demandées, ${c.budget.expectedIfFailedRequested ?? "n/a"} sinon`);
    L.push(`  → ${c.verdict}`);
  }

  const o2 = r.orphans;
  L.push("", "3. VENTES SANS ACHAT CONNU");
  if (o2.status === "impossible") L.push(`  IMPOSSIBLE : ${o2.reason}`);
  else {
    L.push(`  ${o2.salesWithoutKnownBuy} vente(s) sur ${o2.distinctTokens} token(s) distinct(s) · cohérence avec le moteur de PnL : ${o2.engineCrossCheck.agree ? "oui" : `NON (moteur ${o2.engineCrossCheck.engineTokens} tokens / ici ${o2.engineCrossCheck.walkerTokens})`}`);
    const cats: Record<string, number> = {};
    for (const g of o2.groups) cats[g.category] = (cats[g.category] ?? 0) + 1;
    L.push(`  causes : ${Object.entries(cats).map(([k, v]) => `${CAT[k as OrphanGroup["category"]]} ×${v}`).join(" · ") || "aucune"}`);
    for (const g of o2.groups.slice(0, lim(o2.groups))) {
      L.push(`  • ${short(g.mint)} — ${CAT[g.category]}${g.reboughtLater ? " · racheté ensuite" : ""} · ${g.sales.length} vente(s), ${n(g.totalOrphanAmount)} tokens sans achat`);
      for (const sale of g.sales.slice(0, o.all ? g.sales.length : 3)) L.push(`      ${d(sale.date)} slot ${sale.slot ?? "?"} ${short(sale.signature)} vend ${n(sale.tokenAmount)} (inventaire connu ${n(sale.inventoryBefore)}) · +${sale.hoursAfterWindowStart === null ? "?" : sale.hoursAfterWindowStart.toFixed(1)} h après le début de la fenêtre`);
    }
    if (o2.groups.length > lim(o2.groups)) L.push(`  … ${o2.groups.length - lim(o2.groups)} autre(s) token(s) (--all ou --json)`);
  }

  L.push("", "4. MÊME TOKEN, MÊME SLOT");
  if (o2.sameSlot.length === 0) L.push("  aucun achat/vente du même token dans un même slot");
  else {
    L.push(`  ${o2.sameSlot.length} cas dont ${o2.sameSlot.filter((x) => x.effect === "creates_orphan_sale").length} créent une vente orpheline (l'inversion de l'ordre la supprimerait)`);
    for (const x of o2.sameSlot.slice(0, lim(o2.sameSlot))) L.push(`  • ${short(x.mint)} slot ${x.slot} : ${x.sequence.map((q) => `${q.what} ${short(q.signature)}`).join(" → ")} [${x.effect === "creates_orphan_sale" ? "ORDRE DÉTERMINANT" : x.effect === "order_matters" ? "ordre sensible" : "sans effet"}]`);
  }

  const rt = r.rent;
  L.push("", "5. RENT NON ATTRIBUABLE");
  if (rt.status === "impossible") L.push(`  IMPOSSIBLE : ${rt.reason}`);
  else {
    L.push(`  ${rt.uncertainTxs} transaction(s) incertaine(s), ${rt.identifiedTxs} identifiée(s) · dont ${rt.microTradeCases} micro-trade(s) (wallet ≤ 0,005 SOL déplacé)`);
    L.push(`  causes : ${Object.entries(rt.byCause).map(([k, v]) => `${CAUSE[k as keyof typeof CAUSE]} ×${v}`).join(" · ") || "aucune"}`);
    L.push(`  verdicts : ${Object.entries(rt.byVerdict).map(([k, v]) => `${VERDICT[k as keyof typeof VERDICT]} ×${v}`).join(" · ") || "aucun"}`);
    if (rt.reason) L.push(`  ! ${rt.reason}`);
    for (const x of rt.cases.slice(0, lim(rt.cases))) {
      L.push(`  • ${d(x.date)} slot ${x.slot ?? "?"} ${short(x.signature)} ${x.kind}${x.side ? ` ${x.side}` : ""} — ${VERDICT[x.verdict]}`);
      L.push(`      signataires ${x.signerCount}${x.signersComplete ? "" : " (incomplets)"} · payeur des frais ${x.feePayerIsWallet ? "= wallet" : "≠ wallet"} · SOL du wallet ${sol(x.walletLamports)} · trade ${x.tradingSol === null ? "n/a" : `${x.tradingSol.toFixed(6)} SOL`}${x.microTrade ? " (micro)" : ""} · preuve de swap : ${x.swapProof === "counterparty_payment" ? "contrepartie payée" : x.swapProof === "wallet_side_only" ? "côté wallet seulement" : "n/a"} · financeur : ${x.funder ?? "n/a"}`);
      L.push(`      tiers : ${x.thirdParties.map((t) => `${short(t.account)} ${t.role === "fee_payer" ? "payeur" : "co-signataire"} ${t.netLamports >= 0 ? "+" : ""}${t.netLamports}`).join(" ; ") || "aucun"} · pools : ${x.pools.map((p) => `${short(p.account)} ${p.lamports >= 0 ? "+" : ""}${p.lamports}`).join(" ; ") || "aucun"}`);
      L.push(`      comptes : ${x.accounts.slice(0, 5).map((a2) => `${short(a2.account)} ${a2.lamports >= 0 ? "+" : ""}${a2.lamports} [${a2.role}]`).join(" ; ")}`);
      for (const t of x.notes) L.push(`      → ${t}`);
    }
    if (rt.cases.length > lim(rt.cases)) L.push(`  … ${rt.cases.length - lim(rt.cases)} autre(s) (--all ou --json)`);
  }

  const dp = r.depth;
  L.push("", "6. QUELLES POSITIONS BÉNÉFICIERAIENT D'UN HISTORIQUE PLUS PROFOND");
  if (dp.status === "impossible") L.push(`  IMPOSSIBLE : ${dp.reason}`);
  else {
    L.push(`  durée de détention des positions fermées dans la fenêtre (n=${dp.holdSamples}) : médiane ${dp.holdHours.p50?.toFixed(1) ?? "?"} h · p75 ${dp.holdHours.p75?.toFixed(1) ?? "?"} h · p90 ${dp.holdHours.p90?.toFixed(1) ?? "?"} h`);
    const e = dp.extension;
    L.push(`  extension à ${e.targetTransactions} tx : ${e.extraHours === null ? "profondeur gagnée inconnue" : `≈ +${e.extraHours.toFixed(1)} h d'historique`} → ${e.plausiblyCovered === null ? "?" : e.plausiblyCovered} / ${e.of} token(s) orphelin(s) plausiblement couvert(s)`);
    const by: Record<string, number> = {};
    for (const g of dp.perGroup) by[g.verdict] = (by[g.verdict] ?? 0) + 1;
    L.push(`  ${Object.entries(by).map(([k, v]) => `${{ bought_inside_window_expected: "achat attendu DANS la fenêtre (anormal : voir 3-4)", covered_by_modest_extension: "couvert par une extension modeste", beyond_usual_holding_time: "au-delà des durées habituelles", unknown: "inconnu" }[k]} ×${v}`).join(" · ")}`);
  }
  for (const cv of dp.caveats) L.push(`  ! ${cv}`);

  if (r.impossible.length) {
    L.push("", "DIAGNOSTICS IMPOSSIBLES OU PARTIELS");
    for (const i of r.impossible) L.push(`  - ${i.section} : ${i.reason}`);
  }
  L.push("", "Aucune correction appliquée : ce rapport identifie des causes, il ne modifie ni les données ni la comptabilité.");
  return L.join("\n");
}
