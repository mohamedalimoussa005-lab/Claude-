/** Markdown rendering of the report. JSON is the report object itself. */

import type { DetectiveReport, Finding, ReportSection } from "./types.ts";

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
const BADGE: Record<string, string> = { FAIT: "FAIT", INDICE: "INDICE", INCONNU: "INCONNU", "NON SIMULÉ": "NON SIMULÉ" };

function finding(f: Finding): string {
  const anchors = f.anchors?.filter(Boolean).slice(0, 3);
  return `- **[${BADGE[f.level]}]** ${f.text}${anchors && anchors.length ? ` _(ancres: ${anchors.map(short).join(", ")})_` : ""}`;
}

function renderSection(n: number | null, s: ReportSection): string {
  const head = `## ${n === null ? "" : `${n}. `}${s.title}`;
  const status = s.status === "ok" ? "" : s.status === "partial" ? "\n> Section PARTIELLE — voir les limites et inconnues ci-dessous.\n" : s.status === "unsupported" ? "\n> NON SIMULÉ / non pris en charge pour ce token.\n" : "\n> Section INCONNUE — données non établies.\n";
  const body = s.findings.map(finding).join("\n");
  const unk = s.unknowns.length ? `\n**Inconnu :**\n${s.unknowns.map((u) => `- ${u}`).join("\n")}` : "";
  const lim = s.limits.length ? `\n**Limites :**\n${s.limits.map((u) => `- ${u}`).join("\n")}` : "";
  return [head, status, body, unk, lim].filter((x) => x !== "").join("\n") + "\n";
}

export function renderMarkdown(r: DetectiveReport): string {
  const b = r.budget;
  const id = r.sections.identity.data as { mint?: string } | null;
  const lines: string[] = [];
  lines.push(`# DETECTIVE — rapport du token ${r.mint}`);
  lines.push("");
  lines.push(`_Généré le ${r.generatedAt} · mode **${r.mode}** · lecture seule (aucun trade, aucune écriture)_`);
  lines.push("");
  lines.push("> " + r.disclaimers.join("\n> "));
  lines.push("");
  lines.push("| Niveau | Sens |\n|---|---|\n| FAIT | lu directement (signature, slot, compte) ou arithmétique exacte dessus |\n| INDICE | règle explicite ou déclaration d'un tiers : suggestif, jamais une preuve |\n| INCONNU | non établi avec le budget et les sources disponibles |\n| NON SIMULÉ | venue non prise en charge par le moteur de liquidité (raison indiquée) |\n| HYPOTHÈSE | **désactivée** : ce produit n'en émet aucune |");
  lines.push("");
  lines.push(renderSection(null, r.sections.synthesis));
  const order: [number, keyof DetectiveReport["sections"]][] = [[1, "identity"], [2, "creator"], [3, "firstBuyers"], [4, "funding"], [5, "liquidity"], [6, "exitSimulations"], [7, "repetitive"], [8, "social"], [9, "evidence"]];
  for (const [n, k] of order) lines.push(renderSection(n, r.sections[k]));
  lines.push("## Budget consommé");
  lines.push("");
  lines.push(`- Mode **${b.mode}** : ${b.calls} appel(s) RPC sur ${b.maxCalls} autorisés; ${b.httpAttempts === null ? "tentatives HTTP non mesurées" : `${b.httpAttempts} tentative(s) HTTP dont ${b.retries} reprise(s)`}.`);
  lines.push(`- Temps écoulé : ${(b.elapsedMs / 1000).toFixed(1)} s (plafond ${Math.round(b.maxMs / 1000)} s).`);
  lines.push(`- Appels par méthode : ${Object.entries(b.byMethod).map(([m, c]) => `${m} ${c}`).join(", ") || "aucun"}.`);
  lines.push(`- Limites atteintes : ${b.limitsReached.length ? b.limitsReached.join(" ; ") : "aucune"}.`);
  void id;
  return lines.join("\n") + "\n";
}
