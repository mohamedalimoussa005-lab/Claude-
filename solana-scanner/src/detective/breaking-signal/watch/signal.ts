/** One news signal → alert 1 (never waits for the enquiry) → enquiry → alert 2. Same rules as the post pipeline. */

import type { Article } from "../../social-radar/types.ts";
import type { Notifier } from "../notify.ts";
import { delaysOf, latencyOf, timebox } from "../pipeline.ts";
import { NOT_ADVICE } from "../types.ts";
import type { DetectiveBrief, Homonym, LatencySummary, PostEvent, StageTimes } from "../types.ts";
import type { Relevance } from "./relevance.ts";
import type { NewsLevel, NewsVerification } from "./verifyNews.ts";

export interface NewsSignal {
  kind: "new" | "update";
  priorLevel: NewsLevel | null;
  anchor: Article;
  articles: Article[];
  relevance: Relevance;
  verification: NewsVerification;
  /** Times: published = earliest publication, received = our first reading of the anchor article. */
  times: StageTimes;
  provenance: "rss" | "simulation";
}

export interface SignalDeps {
  notifier: Notifier;
  now: () => number;
  fastCheckMs: number;
  findHomonyms?: (names: string[], exclude: string | null) => Promise<Homonym[]>;
  detective?: (mint: string) => Promise<DetectiveBrief>;
}

export interface SignalResult {
  signal: NewsSignal;
  homonyms: Homonym[];
  alert1: string;
  alert2: string | null;
  detective: DetectiveBrief | null;
  times: StageTimes;
  delays: Record<string, number | null>;
  latency: LatencySummary;
}

const utc = (ms: number | null | undefined) => (ms === null || ms === undefined ? "date inconnue" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));
const usd = (n: number | null) => (n === null ? "inconnue" : `${Math.round(n).toLocaleString("fr-FR").replace(/\s/g, " ")} $`);

export function formatNewsAlert1(s: NewsSignal, homonyms: Homonym[], detectiveFollows: boolean): string {
  const v = s.verification;
  const sim = s.provenance === "simulation" ? "[SIMULATION — événement fictif] " : "";
  const L: string[] = [];
  L.push(`${sim}${s.kind === "update" ? "MISE À JOUR" : "ALERTE"}${detectiveFollows ? " 1/2" : ""} — ${v.level} (${v.basis})`);
  L.push(`Sujet: ${s.anchor.title}${s.relevance.priority ? "  [priorité: Trump]" : ""}`);
  if (s.kind === "update" && s.priorLevel) L.push(`Niveau précédent: ${s.priorLevel}`);
  for (const a of s.articles.slice(0, 4)) L.push(`- ${a.publisher}: ${a.title.slice(0, 140)}\n  ${a.url} (publié ${utc(a.publishedAt)})`);
  L.push(`Première publication: ${utc(s.times.published)} · détecté: ${utc(s.times.received)} (+${((s.times.received - s.times.published) / 1000).toFixed(0)} s${s.provenance === "simulation" ? ", écart SIMULÉ: pas un délai réel" : ", retard du flux + intervalle d'interrogation inclus"})`);
  L.push(v.level === "CONFIRMÉ" ? `Statut: annonce confirmée par une source officielle (${v.officialSources.join(", ")}).` : v.basis === "source officielle" ? `Statut: source de classe officielle (${v.officialSources.join(", ")}) mais contrat non confirmé.` : "Statut: annonce rapportée par la presse, NON confirmée par une source officielle.");
  if (v.address) {
    L.push(`Adresse citée: ${v.address} (par ${v.citedBy.join(", ")}) · confirmation officielle: ${v.addressOfficial ? "OUI" : "NON"}`);
    const o = v.onchain;
    L.push(o ? `Vérification rapide on-chain: ${o.state === "valid_mint" ? `mint SPL valide, autorité de mint ${o.mintAuthority === null ? "révoquée" : o.mintAuthority === "UNKNOWN" ? "inconnue" : "ACTIVE"}, autorité de gel ${o.freezeAuthority === null ? "révoquée" : o.freezeAuthority === "UNKNOWN" ? "inconnue" : "ACTIVE"}, ${o.pools.length} pool(s) DEX Screener${o.pools[0] ? ` (liquidité déclarée ${usd(o.pools[0].liquidityUsd)})` : ""}` : `${o.state}${o.reason ? ` — ${o.reason}` : ""}`}` : "Vérification rapide on-chain: INCONNUE (délai dépassé ou indisponible)");
  } else L.push("Adresse de contrat: AUCUNE citée. Aucun token n'est annoncé.");
  if (homonyms.length) L.push(`Tokens au nom proche (NON OFFICIELS, aucun lien établi, un nom n'est pas une annonce): ${homonyms.length}, ex. ${homonyms.slice(0, 3).map((h) => `${h.symbol ?? "?"} ${h.mint.slice(0, 6)}…`).join(", ")}`);
  L.push("Critères: " + v.criteria.map((c) => `${c.id} ${c.ok === true ? "oui" : c.ok === false ? "NON" : "inconnu"}`).join(" · "));
  for (const n of v.notes) L.push(`Note: ${n}`);
  L.push(detectiveFollows ? "Enquête DETECTIVE en cours: résultat dans le message 2/2." : "Aucune enquête lancée (pas d'adresse vérifiable).");
  L.push(NOT_ADVICE);
  return L.join("\n");
}

export function formatNewsAlert2(s: NewsSignal, d: DetectiveBrief, times: StageTimes): string {
  const sim = s.provenance === "simulation" ? "[SIMULATION — événement fictif] " : "";
  const L = [`${sim}ALERTE 2/2 — Enquête DETECTIVE (mode ${d.mode}) — ${s.verification.level} (${s.verification.basis})`, `Token: ${d.mint}`, `Sujet: ${s.anchor.title}`, `Source: ${s.anchor.url}`];
  if (d.status !== "done") L.push(`Enquête ${d.status === "failed" ? "ÉCHOUÉE" : "NON EXÉCUTÉE"}: ${d.reason ?? "raison inconnue"}`);
  else {
    L.push(`${d.calls} appel(s) RPC en ${(d.elapsedMs / 1000).toFixed(0)} s; limites: ${d.limitsReached.length ? d.limitsReached.join(" ; ").slice(0, 300) : "aucune"}`);
    for (const f of d.findings.slice(0, 8)) L.push(`[${f.level}] ${f.text.slice(0, 260)}`);
  }
  if (times.notified1 && times.detectiveDone) L.push(`Délai message 1 → fin d'enquête: ${((times.detectiveDone - times.notified1) / 1000).toFixed(0)} s`);
  L.push(NOT_ADVICE);
  return L.join("\n");
}

/** Sends alert 1 immediately. The enquiry (if any) is returned as a function to run AFTER, so the caller can queue it. */
export async function sendFirstAlert(s: NewsSignal, d: SignalDeps): Promise<{ result: SignalResult; investigate: (() => Promise<SignalResult>) | null }> {
  const times: StageTimes = { ...s.times };
  times.extracted = d.now();
  const v = s.verification;
  const names = [...new Set([...s.relevance.entities.filter((e) => e.length >= 4), ...(s.relevance.entities.length ? [] : s.relevance.crypto.slice(0, 1))])].slice(0, 3);
  const homonyms = d.findHomonyms && names.length ? ((await timebox(d.findHomonyms(names, v.address), d.fastCheckMs)) ?? []) : [];
  times.verified = d.now();
  const willInvestigate = !!d.detective && !!v.address && v.onchain?.state === "valid_mint" && (v.level === "CONFIRMÉ" || v.level === "PROBABLE");
  const alert1 = formatNewsAlert1(s, homonyms, willInvestigate);
  const sent = await d.notifier.send(alert1);
  times.notified1 = sent.at;
  const provenance = s.provenance;
  const pseudo = { provenance } as PostEvent;
  const base: SignalResult = { signal: s, homonyms, alert1, alert2: null, detective: null, times, delays: delaysOf(times), latency: latencyOf(pseudo, times) };
  if (!willInvestigate) return { result: base, investigate: null };
  const investigate = async (): Promise<SignalResult> => {
    times.detectiveStarted = d.now();
    let det: DetectiveBrief;
    try {
      det = await d.detective!(v.address!);
    } catch (e) {
      det = { mint: v.address!, mode: "rapide", calls: 0, elapsedMs: 0, limitsReached: [], status: "failed", reason: e instanceof Error ? e.message : String(e), findings: [] };
    }
    times.detectiveDone = d.now();
    const alert2 = formatNewsAlert2(s, det, times);
    const sent2 = await d.notifier.send(alert2);
    times.notified2 = sent2.at;
    return { ...base, alert2, detective: det, times, delays: delaysOf(times), latency: latencyOf(pseudo, times) };
  };
  return { result: base, investigate };
}
