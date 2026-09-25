/**
 * Pure analysis of collected on-chain data → On-chain Risk (0–100), data
 * confidence and human-readable findings. Independent from the DEX Screener
 * scores. Unknown data is reported as UNKNOWN and never lowers the risk:
 * each unknown carries explicit risk points (config.ts).
 */

import { interpolate } from "../scoring/curve.ts";
import { classifyHolder } from "./classify.ts";
import type { HolderClass } from "./classify.ts";
import { findRelatedWallets } from "./clusters.ts";
import type { RelatedWallets } from "./clusters.ts";
import { ONCHAIN_CONFIG } from "./config.ts";
import type { OnchainConfig } from "./config.ts";
import type { CreatorData, HolderEntry, MintExtension, OnchainData, Section } from "./types.ts";

export type AuthorityState = "DISABLED" | "ACTIVE" | "UNKNOWN";
export type OnchainConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface Concentration {
  top1: number;
  top5: number;
  top10: number;
  top20: number;
}

export interface ClassifiedHolder extends HolderEntry {
  class: HolderClass;
}

export interface HolderAnalysis {
  holderCount: number;
  tokenAccounts: number;
  raw: Concentration;
  /** % of the supply outside verified technical accounts; null if owners could not be classified. */
  adjusted: Concentration | null;
  adjustmentApplied: boolean;
  excluded: ClassifiedHolder[];
  /** Largest holders with their classification. */
  top: ClassifiedHolder[];
  /** Largest non-technical holder, adjusted basis when available. */
  largestNonTechnical: ClassifiedHolder | null;
  /** Multiplier from % of supply to % of adjusted supply. */
  adjustFactor: number;
}

export interface RiskItem {
  label: string;
  detail: string;
  points: number;
}

export interface RiskCategory {
  key: "authorities" | "concentration" | "creator" | "relationships" | "completeness";
  label: string;
  max: number;
  points: number;
  items: RiskItem[];
}

export interface OnchainAnalysis {
  mintAddress: string;
  fetchedAt: number;
  mintAuthority: AuthorityState;
  mintAuthorityAddress: string | null;
  freezeAuthority: AuthorityState;
  freezeAuthorityAddress: string | null;
  tokenProgram: string | null;
  riskyExtensions: string[];
  holders: HolderAnalysis | null;
  creator: CreatorData | null;
  creatorNote: string;
  related: RelatedWallets | null;
  risk: number;
  riskUncapped: number;
  categories: RiskCategory[];
  confidence: OnchainConfidence;
  confidencePoints: number;
  redFlags: string[];
  positives: string[];
  unknowns: string[];
}

const pct = (n: number) => `${n.toFixed(2)} %`;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

const describe = <T>(s: Section<T>): string => (s.status === "unavailable" ? `indisponible (${s.error})` : s.status === "not_found" ? s.reason : "ok");

function concentration(list: { pctOfSupply: number }[], factor: number): Concentration {
  const sum = (n: number) => list.slice(0, n).reduce((s, h) => s + h.pctOfSupply * factor, 0);
  return { top1: sum(1), top5: sum(5), top10: sum(10), top20: sum(20) };
}

function analyzeHolders(data: OnchainData): HolderAnalysis | null {
  if (data.holders.status !== "ok") return null;
  const h = data.holders.value;
  const owners = data.owners.status === "ok" ? data.owners.value : null;
  const top: ClassifiedHolder[] = h.top.map((e) => ({ ...e, class: classifyHolder(e.owner, owners?.[e.owner], data.pairAddress) }));
  const raw = concentration(top, 1);
  if (!owners) {
    return { holderCount: h.holderCount, tokenAccounts: h.tokenAccounts, raw, adjusted: null, adjustmentApplied: false, excluded: [], top, largestNonTechnical: top[0] ?? null, adjustFactor: 1 };
  }
  const excluded = top.filter((t) => t.class.excluded);
  const excludedPct = excluded.reduce((s, t) => s + t.pctOfSupply, 0);
  const factor = excludedPct < 99.99 ? 100 / (100 - excludedPct) : 1;
  const kept = top.filter((t) => !t.class.excluded);
  return {
    holderCount: h.holderCount,
    tokenAccounts: h.tokenAccounts,
    raw,
    adjusted: concentration(kept, factor),
    adjustmentApplied: excluded.length > 0,
    excluded,
    top,
    largestNonTechnical: kept[0] ?? null,
    adjustFactor: factor,
  };
}

const RISKY_EXTENSIONS: Record<string, string> = {
  permanentDelegate: "Token-2022 permanent delegate : une adresse peut transférer ou brûler les tokens de n'importe quel holder",
  transferHook: "Token-2022 transfer hook : un programme externe est appelé à chaque transfert et peut le bloquer",
  transferFeeConfig: "Token-2022 frais de transfert",
  defaultAccountState: "Token-2022 état de compte par défaut gelé",
  nonTransferable: "Token-2022 non transférable",
};

function extensionRisks(exts: MintExtension[], c: OnchainConfig["score"]["authorities"]): RiskItem[] {
  const items: RiskItem[] = [];
  for (const e of exts) {
    const s = e.state ?? {};
    if (e.name === "permanentDelegate" && s.delegate) items.push({ label: RISKY_EXTENSIONS.permanentDelegate, detail: `delegate ${s.delegate}`, points: c.permanentDelegate });
    if (e.name === "transferHook" && s.programId) items.push({ label: RISKY_EXTENSIONS.transferHook, detail: `programme ${s.programId}`, points: c.transferHook });
    if (e.name === "transferFeeConfig") {
      const fee = (k: string) => Number(((s[k] ?? {}) as Record<string, unknown>).transferFeeBasisPoints ?? 0);
      const bps = Math.max(fee("newerTransferFee"), fee("olderTransferFee"));
      if (bps > 0) items.push({ label: RISKY_EXTENSIONS.transferFeeConfig, detail: `${(bps / 100).toFixed(2)} % par transfert`, points: interpolate(c.transferFee, bps) });
    }
    if (e.name === "defaultAccountState" && s.accountState === "frozen") items.push({ label: RISKY_EXTENSIONS.defaultAccountState, detail: "nouveaux comptes gelés par défaut", points: c.defaultFrozen });
    if (e.name === "nonTransferable") items.push({ label: RISKY_EXTENSIONS.nonTransferable, detail: "les tokens ne peuvent pas être transférés", points: c.nonTransferable });
  }
  return items;
}

function category(key: RiskCategory["key"], label: string, max: number, items: RiskItem[]): RiskCategory {
  const kept = items.filter((i) => i.points > 0).map((i) => ({ ...i, points: r1(i.points) }));
  return { key, label, max, points: r1(Math.min(max, kept.reduce((s, i) => s + i.points, 0))), items: kept };
}

export function analyzeOnchain(data: OnchainData, config: OnchainConfig = ONCHAIN_CONFIG): OnchainAnalysis {
  const sc = config.score;
  const red: string[] = [];
  const pos: string[] = [];
  const unk: string[] = [];

  // ─── 1. Authorities ────────────────────────────────────────────────────
  const auth: RiskItem[] = [];
  let mintAuthority: AuthorityState = "UNKNOWN";
  let freezeAuthority: AuthorityState = "UNKNOWN";
  let mintAuthorityAddress: string | null = null;
  let freezeAuthorityAddress: string | null = null;
  let riskyExtensions: string[] = [];
  let tokenProgram: string | null = null;

  if (data.mintInfo.status === "ok") {
    const m = data.mintInfo.value;
    tokenProgram = m.program;
    mintAuthorityAddress = m.mintAuthority;
    freezeAuthorityAddress = m.freezeAuthority;
    mintAuthority = m.mintAuthority ? "ACTIVE" : "DISABLED";
    freezeAuthority = m.freezeAuthority ? "ACTIVE" : "DISABLED";
    if (m.mintAuthority) {
      auth.push({ label: "Mint authority active", detail: m.mintAuthority, points: sc.authorities.mintActive });
      red.push(`Mint authority ACTIVE (${m.mintAuthority}) : cette adresse peut créer de nouveaux tokens et diluer tous les holders.`);
    } else pos.push("Mint authority désactivée : l'offre ne peut plus être augmentée.");
    if (m.freezeAuthority) {
      auth.push({ label: "Freeze authority active", detail: m.freezeAuthority, points: sc.authorities.freezeActive });
      red.push(`Freeze authority ACTIVE (${m.freezeAuthority}) : cette adresse peut geler des comptes de token, ce qui empêche leurs détenteurs de vendre ou transférer.`);
    } else pos.push("Freeze authority désactivée : aucun compte de token ne peut être gelé.");
    const extRisks = extensionRisks(m.extensions, sc.authorities);
    riskyExtensions = extRisks.map((e) => `${e.label} (${e.detail})`);
    auth.push(...extRisks);
    for (const e of extRisks) red.push(`${e.label} (${e.detail}).`);
    if (!extRisks.length) pos.push(m.extensions.length ? "Aucune extension Token-2022 à risque (seulement métadonnées)." : "Aucune extension Token-2022.");
  } else {
    auth.push({ label: "Mint authority inconnue", detail: describe(data.mintInfo), points: sc.authorities.unknownEach });
    auth.push({ label: "Freeze authority inconnue", detail: describe(data.mintInfo), points: sc.authorities.unknownEach });
    unk.push(`Authorities et extensions non vérifiées : compte mint ${describe(data.mintInfo)}.`);
  }

  // ─── 2–3. Holders & concentration ─────────────────────────────────────
  const holders = analyzeHolders(data);
  const conc: RiskItem[] = [];
  if (!holders) {
    conc.push({ label: "Distribution des holders inconnue", detail: describe(data.holders), points: sc.concentration.unknown });
    unk.push(`Distribution des holders non vérifiée : ${describe(data.holders)}.`);
  } else {
    const basis = holders.adjusted ?? holders.raw;
    const basisName = holders.adjusted ? "ajusté" : "brut (ajustement impossible)";
    const top1 = holders.largestNonTechnical ? holders.largestNonTechnical.pctOfSupply * holders.adjustFactor : 0;
    const c = sc.concentration;
    conc.push({ label: "Plus gros holder non technique", detail: `${pct(top1)} (${basisName})`, points: interpolate(c.top1, top1) });
    conc.push({ label: "Top 5", detail: `${pct(basis.top5)} (${basisName})`, points: interpolate(c.top5, basis.top5) });
    conc.push({ label: "Top 10", detail: `${pct(basis.top10)} (${basisName})`, points: interpolate(c.top10, basis.top10) });
    conc.push({ label: "Nombre de holders", detail: String(holders.holderCount), points: interpolate(c.holderCount, holders.holderCount) });
    if (basis.top10 >= c.extreme.top10) conc.push({ label: "Distribution extrêmement concentrée", detail: `top 10 ≥ ${c.extreme.top10} %`, points: c.extreme.points });

    if (!holders.adjusted) unk.push(`Comptes des gros holders non classés (${describe(data.owners)}) : pools et bonding curve non exclus, concentration brute utilisée.`);
    for (const e of holders.excluded) pos.push(`${e.class.label} identifié(e) parmi les gros comptes (${pct(e.pctOfSupply)} de l'offre) et exclu(e) de la concentration ajustée : ${e.class.evidence}.`);
    const unidentified = holders.top.filter((t) => t.class.kind === "programOwned");
    for (const u of unidentified) unk.push(`${short(u.owner)} (${pct(u.pctOfSupply)}) : ${u.class.evidence}.`);
    const lnt = holders.largestNonTechnical;
    if (lnt && top1 >= 10) red.push(`Un compte non technique (${short(lnt.owner)}, ${lnt.class.label.toLowerCase()}) détient ${pct(top1)} de l'offre ${holders.adjusted ? "hors pools / bonding curve / burn" : "(brut)"}. Un gros holder n'est pas forcément malveillant, mais il peut peser fortement sur le prix.`);
    if (basis.top10 >= 40) red.push(`Top 10 très concentré : ${pct(basis.top10)} (${basisName}).`);
    else if (basis.top10 < 25) pos.push(`Top 10 relativement réparti : ${pct(basis.top10)} (${basisName}).`);
    if (holders.holderCount < 100) red.push(`Seulement ${holders.holderCount} holders avec un solde non nul.`);
  }

  // ─── 4. Deployment-associated wallet ─────────────────────────────────
  const cr: RiskItem[] = [];
  const creator = data.creator.status === "ok" ? data.creator.value : null;
  let creatorNote: string;
  if (!creator) {
    creatorNote = `Deployment-associated wallet non identifié : ${describe(data.creator)}.`;
    cr.push({ label: "Deployment-associated wallet inconnu", detail: describe(data.creator), points: sc.creator.unknown });
    unk.push(creatorNote);
  } else {
    creatorNote = `Deployment-associated wallet ${creator.address} (${creator.method}). Adresse liée au déploiement : ce n'est pas une preuve de l'identité du développeur.`;
    if (data.creatorActivity.status !== "ok") {
      cr.push({ label: "Activité du deployment-associated wallet inconnue", detail: describe(data.creatorActivity), points: sc.creator.activityUnknown });
      unk.push(`Activité du deployment-associated wallet non vérifiée : ${describe(data.creatorActivity)}.`);
    } else {
      const a = data.creatorActivity.value;
      if (a.tokenPct === null) {
        cr.push({ label: "Solde de tokens inconnu", detail: "liste des holders indisponible", points: sc.creator.activityUnknown });
        unk.push("Solde de tokens du deployment-associated wallet non vérifié.");
      } else {
        cr.push({ label: "Tokens détenus par le deployment-associated wallet", detail: pct(a.tokenPct), points: interpolate(sc.creator.holding, a.tokenPct) });
        if (a.tokenPct >= 5) red.push(`Le deployment-associated wallet détient encore ${pct(a.tokenPct)} de l'offre.`);
        else if (a.tokenPct < 0.5) pos.push(`Le deployment-associated wallet détient ${pct(a.tokenPct)} de l'offre.`);
      }
      const sells = a.events.filter((e) => e.kind === "sell");
      const sold = -sells.reduce((s, e) => s + e.tokenDeltaPct, 0);
      const recipients = new Set(a.events.filter((e) => e.kind === "transfer").flatMap((e) => e.recipients));
      cr.push({ label: "Ventes récentes", detail: `${sells.length} vente(s) sur ${a.analyzedTransactions} transactions analysées`, points: interpolate(sc.creator.sells, sells.length) });
      cr.push({ label: "Volume vendu", detail: `${pct(sold)} de l'offre`, points: interpolate(sc.creator.soldPct, sold) });
      cr.push({ label: "Transferts vers d'autres wallets", detail: `${recipients.size} wallet(s) destinataire(s)`, points: interpolate(sc.creator.transferRecipients, recipients.size) });
      if (sells.length) red.push(`Le deployment-associated wallet a vendu ${pct(sold)} de l'offre en ${sells.length} transaction(s) parmi ses ${a.analyzedTransactions} dernières analysées.`);
      if (recipients.size >= 2) red.push(`Le deployment-associated wallet a transféré des tokens vers ${recipients.size} wallets différents (${[...recipients].map(short).join(", ")}).`);
      const stillTop = holders ? holders.top.filter((t) => recipients.has(t.owner)) : [];
      if (stillTop.length) {
        red.push(
          `${stillTop.length} wallet(s) ayant reçu des tokens du deployment-associated wallet figurent parmi les plus gros holders : ${stillTop
            .map((t) => `${short(t.owner)} (${pct(t.pctOfSupply * (holders?.adjustFactor ?? 1))})`)
            .join(", ")}.`,
        );
      }
      if (!sells.length && a.analyzedTransactions >= 5) pos.push(`Aucune vente du deployment-associated wallet parmi ses ${a.analyzedTransactions} dernières transactions analysées.`);
      if (a.recentSignatures > config.creator.analyzeTransactions) {
        unk.push(`Activité du deployment-associated wallet : ${a.analyzedTransactions} transaction(s) récente(s) analysée(s) sur ${a.recentSignatures} récupérées ; des ventes plus anciennes ne sont pas vérifiées.`);
      }
    }
  }

  // ─── 5. Potentially related wallets ──────────────────────────────────
  const rel: RiskItem[] = [];
  let related: RelatedWallets | null = null;
  if (data.wallets.status !== "ok") {
    rel.push({ label: "Relations entre wallets non analysées", detail: describe(data.wallets), points: sc.relationships.unknown });
    unk.push(`Relations entre gros wallets non vérifiées : ${describe(data.wallets)}.`);
  } else {
    related = findRelatedWallets(data.wallets.value, { closeCreationMinutes: config.clusters.closeCreationMinutes, busyFunderSignatures: config.clusters.busyFunderSignatures });
    const factor = holders?.adjustFactor ?? 1;
    const biggest = related.groups[0];
    const share = biggest ? biggest.share * factor : 0;
    rel.push({ label: "Plus grand groupe de wallets potentiellement liés", detail: biggest ? `${biggest.members.length} wallets, ${pct(share)}` : "aucun", points: interpolate(sc.relationships.groupShare, share) });
    rel.push({ label: "Liens forts", detail: String(related.strongLinks), points: interpolate(sc.relationships.strongLinks, related.strongLinks) });
    for (const g of related.groups) {
      red.push(`Potentially related wallets : ${g.members.map((m) => short(m.address)).join(", ")} détiennent ensemble ${pct(g.share * factor)} — ${g.reasons.join(" ; ")}. Heuristique, pas une preuve de propriétaire commun.`);
    }
    const unknownFunding = related.analyzed - related.withKnownFunding;
    if (!related.groups.length) pos.push(`Aucun lien détecté entre les ${related.analyzed} plus gros wallets analysés (heuristiques limitées).`);
    if (unknownFunding > 0) unk.push(`${unknownFunding} des ${related.analyzed} wallets analysés : financement initial non déterminé (historique trop long ou premier transfert non identifiable).`);
  }

  // ─── Data completeness ───────────────────────────────────────────────
  const miss = sc.completeness.missing;
  const comp: RiskItem[] = [];
  const sections: [keyof typeof miss, Section<unknown>, string][] = [
    ["mint", data.mintInfo, "compte mint"],
    ["holders", data.holders, "liste des holders"],
    ["owners", data.owners, "classification des gros comptes"],
    ["creator", data.creator, "deployment-associated wallet"],
    ["creatorActivity", data.creatorActivity, "activité du deployment-associated wallet"],
    ["wallets", data.wallets, "historique des gros wallets"],
  ];
  for (const [k, s, label] of sections) if (s.status !== "ok") comp.push({ label: `Donnée manquante : ${label}`, detail: describe(s), points: miss[k] });

  const categories = [
    category("authorities", "Authorities", sc.authorities.max, auth),
    category("concentration", "Holder concentration", sc.concentration.max, conc),
    category("creator", "Creator / deployer", sc.creator.max, cr),
    category("relationships", "Wallet relationships", sc.relationships.max, rel),
    category("completeness", "Data completeness", sc.completeness.max, comp),
  ];
  const riskUncapped = r1(categories.reduce((s, c) => s + c.points, 0));

  // ─── Confidence ──────────────────────────────────────────────────────
  const cp = config.confidence.parts;
  const confidencePoints = sections.reduce((s, [k, sec]) => s + (sec.status === "ok" ? cp[k] : 0), 0);
  let confidence: OnchainConfidence = confidencePoints >= config.confidence.high ? "HIGH" : confidencePoints >= config.confidence.medium ? "MEDIUM" : "LOW";
  if (data.mintInfo.status !== "ok" || data.holders.status !== "ok") confidence = "LOW";

  return {
    mintAddress: data.mintAddress,
    fetchedAt: data.fetchedAt,
    mintAuthority,
    mintAuthorityAddress,
    freezeAuthority,
    freezeAuthorityAddress,
    tokenProgram,
    riskyExtensions,
    holders,
    creator,
    creatorNote,
    related,
    risk: Math.round(Math.min(100, riskUncapped)),
    riskUncapped,
    categories,
    confidence,
    confidencePoints,
    redFlags: red,
    positives: pos,
    unknowns: unk,
  };
}
