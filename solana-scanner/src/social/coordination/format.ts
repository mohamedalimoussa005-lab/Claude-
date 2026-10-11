/**
 * Plain-text (French) rendering of a CoordinationResult for reports. Observed facts, statistical indications and
 * hypotheses are labelled; limits come first-class, never in a footnote.
 */

import type { CoordinationResult } from "./analyze.ts";

const pct = (x: number | null, d = 1): string => (x === null ? "n/a" : `${(x * 100).toFixed(d)} %`);
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;


export function formatCoordination(r: CoordinationResult): string {
  const amount = (l: bigint): string => (r.quoteDecimals === null ? `${l} unités brutes de ${short(r.quoteMint)}` : `${(Number(l) / 10 ** r.quoteDecimals).toFixed(2)} ${r.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : short(r.quoteMint)}`);
  const L = r.launch;
  const out: string[] = [];
  out.push(`Coordination — ${short(r.mint)}  [mesures, pas des conclusions]`);
  out.push(`Couverture: ${r.coverage.signaturesRead} signatures listées (${r.coverage.signaturesComplete ? "historique complet" : "HISTORIQUE INCOMPLET"}), ${r.coverage.transactionsRead} transactions lues, ${r.coverage.transactionsMissing} manquantes${r.scopeLimited ? " — analyse limitée aux plus anciennes" : ""}`);
  out.push(`[FAIT VÉRIFIÉ] ${r.swaps.length} swaps lus (${r.swaps.filter((s) => s.side === "buy").length} achats), ${r.transfers.length} transferts exacts entre wallets${Object.keys(r.skipped).length ? `, non classés: ${JSON.stringify(r.skipped)}` : ""}`);
  out.push(`Lancement: ${L.launchObserved ? "observé" : "NON observé"}; cohorte ${L.cohort.length} acheteurs; ${L.buyersFirstSlot} au premier slot, ${L.buyersWithin5Slots} dans les 5 premiers; part de l'offre ${pct(L.cohortSupplyShare, 2)}; top-5 = ${pct(L.top5BuyShare)} des achats de la cohorte`);
  out.push(`[INDICE statistique] paires synchrones ${L.sync.observedPairs} observées vs ${L.sync.expectedPairs.toFixed(1)} attendues (p=${L.sync.pValue === null ? "n/a" : L.sync.pValue.toFixed(3)}${L.sync.unusual ? ", inhabituel" : ""})`);
  out.push(`Financement: ${r.funding.wallets.length} wallets remontés${r.funding.notTraced.length ? ` (+${r.funding.notTraced.length} non remontés)` : ""}, ${r.funding.unavailable.length} sans historique, ${r.funding.wallets.filter((w) => w.partial).length} partiels`);
  for (const s of r.funding.shared.slice(0, 6)) {
    out.push(`  - source ${short(s.source)} (saut ${s.hop}): ${s.wallets.length} wallets, ${s.discriminating ? "non neutre" : `NEUTRE/NON DISCRIMINANT${s.entity ? ` (${s.entity.label})` : s.probableService ? " (wallet très actif)" : ""}`}${s.similarAmounts ? ", montants proches" : ""}${s.burst ? ", en rafale" : ""}`);
  }
  for (const g of r.cluster.groups.slice(0, 6)) {
    out.push(`[${g.hypothesisEligible ? "HYPOTHÈSE possible" : "INDICE"}] groupe ${g.id}: ${g.wallets.length} wallets, familles ${g.families.join("+")}${g.strength === "single_signal" ? " (un seul signal)" : ""}`);
  }
  if (r.cluster.groups.length === 0) out.push("Groupes à signaux multiples: aucun");
  const W = r.wash;
  out.push(`Volume: ${W.swaps} swaps, ~${amount(W.grossQuote)}, ${W.distinctTraders} wallets jugés; aller-retours ${pct(W.roundTripShare)}${W.permutation ? ` (modèle nul: moyenne ${pct(W.permutation.nullMean)}, p95 ${pct(W.permutation.nullP95)}, p=${W.permutation.pValue.toFixed(3)})` : ""}; wallets réguliers ${W.cadence.filter((c) => c.metronomic).length}; cycles de transferts ${W.transferCycles.length}`);
  for (const f of W.flags) out.push(`  ! ${f}`);
  out.push("Limites:");
  for (const l of r.limits) out.push(`  - ${l}`);
  return out.join("\n");
}
