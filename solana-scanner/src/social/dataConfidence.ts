/**
 * Evidence Data Confidence (0–100): how reliable the evidence collected about a
 * token is. Four components, all computed from the ledger's METADATA only
 * (status, source, anchor, type, observation time) — never from a fact's value:
 *
 *   completeness   share of the expected checks backed by a FACT or an INDICATION
 *   freshness      how recent the time-sensitive observations are (immutable ones never age)
 *   verifiability  status weight × anchor factor, averaged over all entries (UNVERIFIED counts 0)
 *   sources        mean source reliability + reward for facts corroborated by two sources
 *
 * Caps keep the score honest: with no on-chain FACT, or a single source, it cannot be high.
 *
 * This is NOT a probability of profit and not a risk or opportunity score. A token with a
 * +1000 % move and one with a −95 % move score the same if their evidence is equally solid.
 * It is separate from the wallet "Data Confidence" in src/wallets and from the DEX Confidence.
 */

import { SOCIAL_CONFIG } from "./config.ts";
import type { SocialConfig } from "./config.ts";
import type { Evidence, EvidenceStatus, EvidenceSource, EvidenceType } from "./types.ts";
import { EVIDENCE_STATUSES } from "./types.ts";
import type { EvidenceLedger } from "./ledger.ts";

export type DataConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface ConfidenceComponent {
  key: "completeness" | "freshness" | "verifiability" | "sources";
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface ConfidenceCap {
  key: "no_onchain_fact" | "single_source";
  limit: number;
  applied: boolean;
  reason: string;
}

export interface EvidenceDataConfidence {
  mint: string | null;
  /** null when the ledger holds nothing about the token: unknown, never 0. */
  score: number | null;
  level: DataConfidenceLevel;
  components: ConfidenceComponent[];
  caps: ConfidenceCap[];
  statusCounts: Record<EvidenceStatus, number>;
  /** Expected checks without a FACT / INDICATION, plus what the entries say is missing. */
  missing: string[];
  /** Limits stated by the entries, plus limits detected while scoring. */
  limits: string[];
  evaluatedAt: number;
  interpretation: "reliability_of_collected_evidence_not_a_probability_of_profit";
}

const ONCHAIN: readonly EvidenceSource[] = ["helius", "solana_rpc"];
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const unique = <T>(a: T[]): T[] => [...new Set(a)];

function anchorFactor(e: Evidence, cfg: SocialConfig["dataConfidence"]): number {
  if (e.signature !== null || e.slot !== null) return cfg.anchorFactor.transaction;
  if (e.addresses.length > 0 || e.url !== null) return cfg.anchorFactor.account;
  return cfg.anchorFactor.none;
}

/** 1 = fresh, 0 = stale. Immutable observations never age. */
function freshness(e: Evidence, now: number, cfg: SocialConfig["dataConfidence"], limits: string[]): number | null {
  const vol = cfg.volatility[e.type];
  if (vol === "immutable") return null;
  const observed = Date.parse(e.observedAt);
  let ageMin = (now - observed) / 60_000;
  if (ageMin < 0) {
    limits.push(`observation datée après l'évaluation (${e.type}, ${e.observedAt}): âge ramené à 0`);
    ageMin = 0;
  }
  const { fullMinutes, zeroMinutes } = cfg.decay[vol];
  if (ageMin <= fullMinutes) return 1;
  if (ageMin >= zeroMinutes) return 0;
  return clamp01(1 - (ageMin - fullMinutes) / (zeroMinutes - fullMinutes));
}

export function scoreEvidenceDataConfidence(ledger: EvidenceLedger, mint: string | null, now: number, config: SocialConfig = SOCIAL_CONFIG): EvidenceDataConfidence {
  const cfg = config.dataConfidence;
  const entries = mint === null ? ledger.all().filter((e) => e.mint === null) : ledger.forMint(mint);
  const statusCounts = { FACT: 0, INDICATION: 0, HYPOTHESIS: 0, UNVERIFIED: 0 } as Record<EvidenceStatus, number>;
  for (const s of EVIDENCE_STATUSES) statusCounts[s] = entries.filter((e) => e.status === s).length;

  const limits: string[] = [];
  const missing: string[] = [];

  // Entries that describe a gap do not count as evidence about the token.
  const evidence = entries.filter((e) => e.type !== "data_gap");
  for (const e of entries) {
    limits.push(...e.limits);
    missing.push(...e.missing);
  }

  const established = (type: EvidenceType) => evidence.some((e) => e.type === type && (e.status === "FACT" || e.status === "INDICATION"));
  const unmetChecks = cfg.expectedChecks.filter((t) => !established(t));
  for (const t of unmetChecks) missing.push(`aucun FAIT ni INDICE de type ${t}`);

  if (evidence.length === 0) {
    return {
      mint,
      score: null,
      level: "UNKNOWN",
      components: [],
      caps: [],
      statusCounts,
      missing: unique(missing),
      limits: unique([...limits, "aucune preuve enregistrée pour ce token"]),
      evaluatedAt: now,
      interpretation: "reliability_of_collected_evidence_not_a_probability_of_profit",
    };
  }

  // 1. Completeness
  const met = cfg.expectedChecks.length - unmetChecks.length;
  const completeness = cfg.expectedChecks.length === 0 ? 1 : met / cfg.expectedChecks.length;

  // 2. Freshness (time-sensitive, non-UNVERIFIED entries only)
  const fresh = evidence.filter((e) => e.status !== "UNVERIFIED").map((e) => freshness(e, now, cfg, limits)).filter((f): f is number => f !== null);
  const freshnessAvg = fresh.length === 0 ? 1 : fresh.reduce((s, f) => s + f, 0) / fresh.length;

  // 3. Verifiability
  const verif = evidence.map((e) => cfg.statusWeight[e.status] * anchorFactor(e, cfg));
  const verifAvg = verif.reduce((s, v) => s + v, 0) / verif.length;

  // 4. Source quality + corroboration
  const counted = evidence.filter((e) => e.status !== "UNVERIFIED");
  const reliabilityAvg = counted.length === 0 ? 0 : counted.reduce((s, e) => s + cfg.sourceReliability[e.source], 0) / counted.length;
  const types = unique(counted.map((e) => e.type));
  const corroborated = types.filter((t) => unique(counted.filter((e) => e.type === t && (e.status === "FACT" || e.status === "INDICATION")).map((e) => e.source)).length >= 2);
  const corroboration = types.length === 0 ? 0 : corroborated.length / types.length;
  const sourcesScore = cfg.reliabilityShare * reliabilityAvg + (1 - cfg.reliabilityShare) * corroboration;

  const w = cfg.weights;
  const components: ConfidenceComponent[] = [
    { key: "completeness", label: "Complétude", points: r1(w.completeness * completeness), max: w.completeness, note: `${met}/${cfg.expectedChecks.length} vérifications attendues établies` },
    { key: "freshness", label: "Fraîcheur", points: r1(w.freshness * freshnessAvg), max: w.freshness, note: fresh.length === 0 ? "aucune donnée sensible au temps" : `moyenne sur ${fresh.length} observation(s) sensibles au temps` },
    { key: "verifiability", label: "Vérifiabilité", points: r1(w.verifiability * verifAvg), max: w.verifiability, note: `${statusCounts.FACT} fait(s), ${statusCounts.INDICATION} indice(s), ${statusCounts.HYPOTHESIS} hypothèse(s), ${statusCounts.UNVERIFIED} non vérifié(s)` },
    { key: "sources", label: "Qualité des sources", points: r1(w.sources * sourcesScore), max: w.sources, note: `fiabilité moyenne ${r1(reliabilityAvg * 100)} %, ${corroborated.length}/${types.length} type(s) corroboré(s) par 2 sources` },
  ];
  const raw = r1(components.reduce((s, c) => s + c.points, 0));

  // Caps
  const hasOnchainFact = evidence.some((e) => e.status === "FACT" && ONCHAIN.includes(e.source));
  const sourceCount = unique(counted.map((e) => e.source)).length;
  const caps: ConfidenceCap[] = [
    { key: "no_onchain_fact", limit: cfg.caps.noOnchainFact, applied: !hasOnchainFact, reason: "aucun FAIT lu on-chain (Helius / RPC Solana)" },
    { key: "single_source", limit: cfg.caps.singleSource, applied: sourceCount <= 1, reason: "une seule source" },
  ];
  const appliedLimits = caps.filter((c) => c.applied).map((c) => c.limit);
  const score = r1(Math.min(raw, ...appliedLimits));
  if (score < raw) limits.push(`score plafonné à ${score} (brut ${raw}): ${caps.filter((c) => c.applied).map((c) => c.reason).join("; ")}`);

  const level: DataConfidenceLevel = score >= cfg.levels.high ? "HIGH" : score >= cfg.levels.medium ? "MEDIUM" : "LOW";
  return { mint, score, level, components, caps, statusCounts, missing: unique(missing), limits: unique(limits), evaluatedAt: now, interpretation: "reliability_of_collected_evidence_not_a_probability_of_profit" };
}
