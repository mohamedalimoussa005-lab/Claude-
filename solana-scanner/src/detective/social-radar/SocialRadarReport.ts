/** Markdown rendering of a radar report (French, like the DETECTIVE report). */

import type { RadarReport } from "./run.ts";

const when = (ms: number | null) => (ms === null ? "date inconnue" : new Date(ms).toISOString().replace(".000Z", "Z"));
const age = (ms: number | null, now: number) => {
  if (ms === null) return "inconnue";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 90 ? `${m} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} j`;
};
const usd = (n: number | null) => (n === null ? "inconnue" : `${Math.round(n).toLocaleString("fr-FR").replace(/\s/g, " ")} $`);

export function renderRadarMarkdown(r: RadarReport): string {
  const now = Date.parse(r.generatedAt);
  const L: string[] = [];
  L.push(`# DETECTIVE — Social Radar (actualités → tokens)`, "", `_Généré le ${r.generatedAt} · mode **news first** · lecture seule · coût **0 $**_`, "");
  for (const d of r.disclaimers) L.push(`> ${d}`);
  L.push("", "| Niveau | Sens |", "|---|---|", "| FAIT | adresse citée ou lien déclaré par le projet |", "| INDICE | correspondance de nom ou de symbole, jamais une affiliation |", "| TENDANCE INCONNUE | historique insuffisant, aucun pourcentage inventé |", "");
  L.push("## Sources", "");
  for (const s of r.sources) L.push(`- **${s.source}** — ${s.state === "ok" ? "OK" : s.state === "partial" ? "PARTIEL" : s.state === "not_used" ? "NON UTILISÉE" : "INDISPONIBLE (INCONNU)"} · ${s.requests} requête(s) · ${s.articles} élément(s) · donnée la plus récente: ${s.newestAt ? `${when(s.newestAt)} (il y a ${age(s.newestAt, now)})` : "inconnue"}${s.reason ? ` · ${s.reason}` : ""}`);
  L.push("", `${r.articlesRead} article(s) lu(s), ${r.duplicatesRemoved} doublon(s) retiré(s), ${r.storiesFound} sujet(s) regroupé(s) dont ${r.storiesSkippedSinglePublisher} écarté(s) (un seul éditeur).`, "");
  L.push("## Sujets", "");
  if (r.stories.length === 0) L.push("Aucun sujet exploitable.", "");
  r.stories.forEach((res, i) => {
    const s = res.story;
    const first = s.articles[0]!;
    L.push(`### ${i + 1}. ${s.title}`, "");
    L.push(`- Source: ${first.publisher} — [lien original](${first.url}) · publié ${when(first.publishedAt)} (il y a ${age(first.publishedAt, now)})`);
    L.push(`- Fraîcheur: article le plus récent il y a ${age(s.newestAt, now)}; ${s.articles.length} article(s) distinct(s) de ${s.distinctPublishers} éditeur(s)`);
    L.push(`- Évolution observable: **${res.trend.label}**${res.trend.reason ? ` (${res.trend.reason})` : ""}`);
    if (s.disputed) L.push(`- ⚠ Actualité contestée: ${s.stance.confirm} article(s) l'annoncent, ${s.stance.deny} la démentent ou la relativisent. Liens: ${s.articles.slice(0, 4).map((a) => `[${a.publisher}](${a.url})`).join(", ")}`);
    else L.push(`- Autres articles: ${s.articles.slice(1, 4).map((a) => `[${a.publisher}](${a.url})`).join(", ") || "aucun"}`);
    L.push(`- Expressions extraites: ${s.phrases.join(", ") || "aucune"}${s.tickers.length ? ` · tickers cités: ${s.tickers.map((t) => `$${t}`).join(", ")}` : ""}${s.addresses.length ? ` · adresses citées: ${s.addresses.join(", ")}` : ""}`);
    if (res.matches.length === 0) L.push("- Tokens potentiellement associés: **aucun trouvé** avec les expressions testées.");
    else {
      L.push("- Tokens potentiellement associés:");
      for (const m of res.matches) {
        L.push(`  - **[${m.evidence}]** ${m.name ?? "nom inconnu"} (${m.symbol ?? "?"}) \`${m.mint}\` · force ${m.strength}/5 (${m.level}) · liquidité déclarée ${usd(m.liquidityUsd)}${m.dexUrl ? ` · [DEX Screener](${m.dexUrl})` : ""}`);
        L.push(`    - Pourquoi: ${m.because}.`);
        for (const w of m.warnings) L.push(`    - ⚠ ${w}`);
      }
    }
    if (res.missing.length) L.push(`- Données manquantes: ${res.missing.join(" ; ")}`);
    L.push("");
  });
  L.push("## Candidats transmis à DETECTIVE (mode rapide)", "");
  if (r.candidates.length === 0) L.push(`Aucun. ${r.gaps.find((g) => g.startsWith("aucun token")) ?? "Aucun token de force suffisante."}`, "");
  for (const c of r.candidates) {
    L.push(`### ${c.match.name ?? c.match.mint} (${c.match.symbol ?? "?"}) — \`${c.match.mint}\``, "", `- Actualité: ${c.storyTitle}`, `- Association: **[${c.match.evidence}]** ${c.match.level} (force ${c.match.strength}/5). ${c.match.because}.`);
    const d = c.detective;
    if (!d) L.push("- Résumé on-chain: non exécuté.");
    else if (d.status !== "done") L.push(`- Résumé on-chain: **${d.status === "failed" ? "ÉCHEC" : "IGNORÉ"}** — ${d.reason ?? "raison inconnue"}`);
    else {
      L.push(`- Résumé on-chain (DETECTIVE ${d.mode}, ${d.calls} appel(s) RPC, ${(d.elapsedMs / 1000).toFixed(0)} s; limites: ${d.limitsReached.length ? d.limitsReached.join(" ; ") : "aucune"}):`);
      for (const f of d.findings) L.push(`  - **[${f.level}]** ${f.text}`);
      for (const u of d.unknowns.slice(0, 5)) L.push(`  - **[INCONNU]** ${u}`);
    }
    L.push("");
  }
  L.push("## Données manquantes", "");
  for (const g of r.gaps) L.push(`- ${g}`);
  L.push("- Publications X: non collectées (INCONNU).", "");
  L.push("## Budget consommé", "", `- ${r.budget.requests} requête(s) sur ${r.budget.maxRequests} autorisées (${Object.entries(r.budget.byHost).map(([h, n]) => `${h} ${n}`).join(", ") || "aucune"}); temps ${(r.budget.elapsedMs / 1000).toFixed(1)} s sur ${Math.round(r.budget.maxMs / 1000)} s.`, `- Coût: 0 $ (sources gratuites uniquement).`, `- Limites atteintes: ${r.budget.limitsReached.length ? r.budget.limitsReached.join(" ; ") : "aucune"}.`, `- Entrées du grand livre de preuves: ${r.ledgerEntries}.`, "");
  return L.join("\n");
}
