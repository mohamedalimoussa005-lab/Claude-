import { short } from "../diagnose/rent.ts";
import type { Comparison, StatusCounts } from "./compare.ts";

const st = (s: StatusCounts) => `${s.KNOWN} connues · ${s.PARTIAL} partielles · ${s.PROVISIONAL} provisoires · ${s.UNKNOWN} inconnues`;
const sol = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)} SOL`;

export function formatComparison(c: Comparison, o: { all?: boolean } = {}): string {
  const L: string[] = [];
  L.push(`══ COMPARAISON AVANT / APRÈS — wallet ${short(c.wallet)} ══  (lecture seule · aucun réseau · aucun fichier modifié)`);
  L.push(`${c.transactions} transactions du cache passées dans l'ancien moteur (v1, figé) et le nouveau (v2).`);
  L.push(`⚠ ${c.reliability.message}`);

  L.push("", "1. CLASSEMENT DES TRANSACTIONS");
  for (const k of ["v1", "v2"] as const) {
    const x = c.counts[k];
    L.push(`  ${k} : ${x.buys} achats · ${x.sells} ventes · ${x.transfersIn} transferts entrants · ${x.transfersOut} sortants · ${x.undecodable} non décodables · loyer prouvé ${x.rentIdentified} · loyer incertain ${x.rentUncertain}`);
  }

  L.push("", `2. LOYER INCERTAIN : ${c.rent.v1Uncertain} → ${c.rent.v2Uncertain} transaction(s)  (${c.rent.resolved} résolue(s), ${c.rent.newlyUncertain} devenue(s) incertaine(s))`);
  const why = Object.entries(c.rent.v2ByReason);
  L.push(why.length ? `  restant en v2 : ${why.map(([k, v]) => `${k} ×${v}`).join(" · ")}` : "  plus aucun cas incertain en v2");

  const lim = o.all ? c.reclassified.length : Math.min(c.reclassified.length, 15);
  L.push("", `3. TRANSACTIONS RECLASSÉES : ${c.reclassified.length}`);
  for (const r of c.reclassified.slice(0, lim)) {
    L.push(`  • ${r.date ?? "?"} slot ${r.slot ?? "?"} ${short(r.signature)}${r.mint ? ` token ${short(r.mint)}` : ""}  [${r.changes.join("+")}]`);
    L.push(`      avant : ${r.before}`);
    L.push(`      après : ${r.after}`);
    for (const e of r.explanation) L.push(`      → ${e}`);
  }
  if (c.reclassified.length > lim) L.push(`  … ${c.reclassified.length - lim} autre(s) (--all ou --json)`);

  L.push("", "4. POSITIONS FERMÉES");
  L.push(`  v1 : ${st(c.positions.v1)} · ventes sans achat connu ${c.positions.orphanSalesV1}`);
  L.push(`  v2 : ${st(c.positions.v2)} · ventes sans achat connu ${c.positions.orphanSalesV2}`);
  L.push(`  tokens dont les positions ont changé : ${c.positions.changedTokens.length}`);
  for (const t of c.positions.changedTokens.slice(0, o.all ? c.positions.changedTokens.length : 8)) L.push(`    ${short(t.mint)} : ${t.v1.join(", ") || "—"} → ${t.v2.join(", ") || "—"}`);

  L.push("", "5. PnL INDICATIF (non fiable tant que l'historique est tronqué)");
  L.push(`  v1 ${sol(c.pnl.v1.indicativeSol)} · v2 ${sol(c.pnl.v2.indicativeSol)}  — loyer immobilisé : v1 ${c.pnl.v1.rentLockedSol.toFixed(6)} · v2 ${c.pnl.v2.rentLockedSol.toFixed(6)} SOL`);
  L.push(`  ${c.pnl.note}`);

  L.push("", "6. VALIDATION DE LA DÉRIVATION D'ADRESSES SUR CES DONNÉES");
  L.push(`  ${c.derivationCheck.verdict}`);
  L.push("", "Aucune donnée d'origine n'est modifiée. Rien ici n'est un conseil financier, et aucun wallet n'est étiqueté.");
  return L.join("\n");
}
