/** Public links declared on DEX Screener. Existence of a link is a third-party declaration, never a verification. */

import type { DexProfile } from "./resolve.ts";
import type { Finding, ReportSection } from "./types.ts";
import { section } from "./types.ts";

export interface SocialData {
  websites: { url: string; label?: string }[];
  socials: { type: string; url: string }[];
  domains: string[];
  source: "dexscreener";
}

export function buildSocial(profile: DexProfile, hasPool: boolean): ReportSection<SocialData> {
  const links = [...profile.websites, ...profile.socials];
  const domains = [...new Set(links.map((l) => { try { return new URL(l.url).hostname.replace(/^www\./, ""); } catch { return null; } }).filter((d): d is string => d !== null))].sort();
  const findings: Finding[] = [];
  if (links.length === 0) {
    findings.push({ level: "INCONNU", text: hasPool ? "Aucun lien public (site, X, Telegram…) déclaré sur DEX Screener pour ce token." : "Aucun pool DEX Screener: aucun lien public disponible." });
  } else {
    findings.push({ level: "INDICE", text: `${links.length} lien(s) public(s) déclaré(s) sur DEX Screener (${domains.join(", ")}): déclaration d'un tiers, non vérifiée (rien ne prouve que le compte appartient à l'équipe).`, anchors: links.map((l) => l.url) });
  }
  return section("Signaux sociaux disponibles", {
    status: links.length ? "ok" : "unknown",
    data: { websites: profile.websites.map((w) => ({ url: w.url, ...(w.label ? { label: w.label } : {}) })), socials: profile.socials.map((s) => ({ type: s.type, url: s.url })), domains, source: "dexscreener" },
    findings,
    unknowns: ["activité, ancienneté et authenticité des comptes sociaux (aucune collecte X en direct: elle exigerait un service payant)", "contenu des publications"],
    limits: ["seuls les liens déclarés sur DEX Screener sont lus; aucun contenu social n'est analysé"],
  });
}
