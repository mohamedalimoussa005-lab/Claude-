/**
 * Readable synthesis. Rules: one sentence per point, each with its level; numbers, never adjectives of guilt; no verdict,
 * no score, no probability; unknowns and reached limits come first when the picture is partial.
 */

import type { CreatorData, IdentityData } from "./identity.ts";
import type { LiquidityData } from "./liquidity.ts";
import type { BudgetReport, DetectiveReport, Finding, ReportSection } from "./types.ts";
import { section } from "./types.ts";

type Sections = DetectiveReport["sections"];

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("fr-FR")} $`);
const pct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "n/a" : `${n.toFixed(d)} %`);
const data = <T>(s: ReportSection): T | null => s.data as T | null;

export function buildSynthesis(s: Omit<Sections, "synthesis"> & { synthesis?: ReportSection }, budget: BudgetReport): ReportSection {
  const f: Finding[] = [];
  const unknownSections = (Object.entries(s) as [string, ReportSection][]).filter(([k, v]) => k !== "synthesis" && (v.status === "unknown" || v.status === "partial")).map(([, v]) => v.title);
  const unsupported = (Object.entries(s) as [string, ReportSection][]).filter(([k, v]) => k !== "synthesis" && v.status === "unsupported").map(([, v]) => v.title);

  if (budget.limitsReached.length > 0) f.push({ level: "INCONNU", text: `Limites atteintes pendant l'analyse: ${budget.limitsReached.join(" ; ")}. Les sections concernées sont partielles.` });
  if (unknownSections.length > 0) f.push({ level: "INCONNU", text: `Sections partielles ou inconnues: ${unknownSections.join(", ")}.` });
  if (unsupported.length > 0) f.push({ level: "NON SIMULÉ", text: `Non simulé / non pris en charge: ${unsupported.join(", ")}.` });

  // identity & authorities
  const id = data<IdentityData>(s.identity);
  if (id) {
    const att: string[] = [];
    if (id.mintAuthority !== null && id.mintAuthority !== "UNKNOWN") att.push("autorité de mint active");
    if (id.freezeAuthority !== null && id.freezeAuthority !== "UNKNOWN") att.push("autorité de gel active");
    if (id.permanentDelegate) att.push("délégué permanent Token-2022");
    if (id.transferHookProgram) att.push("transfer hook Token-2022");
    if (id.transferFee && (id.transferFee.currentBps ?? id.transferFee.newerBps) > 0) att.push(`frais de transfert ${((id.transferFee.currentBps ?? id.transferFee.newerBps) / 100).toFixed(2)} %`);
    if (id.supply !== null) f.push(att.length ? { level: "FAIT", text: `Contrôles présents sur le token: ${att.join(", ")}. Ils donnent à une adresse un pouvoir réel (créer, geler, déplacer, taxer); la question est de savoir qui la contrôle, ce que ce rapport ne peut pas établir.` } : { level: "FAIT", text: "Aucune autorité de mint ou de gel active, aucun délégué permanent, hook ni frais de transfert natifs détectés." });
    if (id.holders) f.push({ level: "FAIT", text: `Concentration: les 10 plus gros détenteurs (hors comptes techniques) en ont ${pct(id.holders.adjustedTop10 ?? id.holders.rawTop10)} de l'offre; le premier en a ${pct(id.holders.adjustedTop1 ?? id.holders.rawTop1)}.` });
  }
  const cr = data<CreatorData>(s.creator);
  if (cr?.address && cr.tokenPct !== null) f.push({ level: "INDICE", text: `Le wallet associé au déploiement (non prouvé comme développeur) détient ${pct(cr.tokenPct)} de l'offre${cr.events.some((e) => e.kind === "sell") ? " et a vendu dans les transactions récentes analysées" : ""}.` });

  // liquidity
  const liq = data<LiquidityData>(s.liquidity);
  if (liq?.depth) {
    const d = liq.depth;
    const exact = d.info.formulaAssurance === "program_source" && d.complete;
    const lvl = exact ? ("FAIT" as const) : ("INDICE" as const);
    const bid1 = d.bid.find((x) => x.impactBps === 100);
    const bid5 = d.bid.find((x) => x.impactBps === 500);
    const ask1 = d.ask.find((x) => x.impactBps === 100);
    if (ask1?.reached && bid1) f.push({ level: lvl, text: `À l'instant lu, ${usd(ask1.input?.usd)} d'achats font monter le prix de 1 %; côté vente, ${bid1.reached ? `${usd(bid1.output?.usd)} reçus font baisser le prix de 1 %` : `le prix ne peut pas baisser de 1 % (au plus ${usd(bid1.output?.usd)} récupérables avant épuisement de la liquidité de vente)`}.` });
    if (bid5 && !bid5.reached) f.push({ level: lvl, text: `La liquidité de vente est épuisée avant −5 %: la sortie de grosses positions peut être impossible au prix affiché.` });
    const rt = d.roundTrips.find((r) => r.usd === 1000);
    if (rt?.ok) f.push({ level: lvl, text: `Aller-retour immédiat de 1 000 $ : perte de ${pct(rt.lossPct, 2)} (frais et taxes inclus).` });
    const sell5 = d.supplySells.find((t) => t.label.includes("5%"));
    if (sell5) f.push({ level: lvl, text: sell5.ok ? `Vendre 5 % de l'offre rapporterait ${usd(sell5.amountOut?.usd)} (impact d'exécution ${pct(sell5.executionImpactPct)}).` : `Vendre 5 % de l'offre n'est pas exécutable dans l'état du pool (capacité ${usd(sell5.capacity?.output.usd)}).` });
    if (!exact) f.push({ level: "INDICE", text: "Ces chiffres de liquidité sont des estimations (formules non publiques ou données incomplètes)." });
  }

  // launch / coordination (summaries produced by the launch step)
  for (const k of ["firstBuyers", "funding", "repetitive"] as const) {
    const sec = s[k];
    const summary = (sec.data as { synthesis?: Finding[] } | null)?.synthesis;
    if (summary) f.push(...summary);
  }
  f.push({ level: "INDICE", text: "Aucun verdict n'est émis: ni fraude, ni probabilité, ni conseil. Les hypothèses de coordination sont désactivées; les groupes décrits sont des ressemblances de comportement ou de financement." });
  return section("Synthèse", { status: "ok", findings: f, unknowns: [], limits: [] });
}
