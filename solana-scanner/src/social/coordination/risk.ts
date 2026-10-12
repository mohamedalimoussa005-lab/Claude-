/**
 * Coordination risk — DRAFT, NOT WIRED ANYWHERE.
 *
 * An independent score for the future: how many independent indicators of coordinated behaviour a token shows.
 * It is separate from Opportunity, Risk, Quality, Confidence, the Evidence Data Confidence and the draft liquidity
 * risk; nothing in the scanner reads it. Status "draft_unvalidated": weights and thresholds are proposals that
 * have never been calibrated on labelled launches. Higher = more indicators. It is not a probability of fraud,
 * says nothing about intent, and a component whose input is unknown is reported as unknown (never counted as 0).
 */

import type { CoordinationResult } from "./analyze.ts";

export interface CoordinationFeatures {
  launchObserved: boolean;
  dataComplete: boolean;
  cohortSize: number;
  cohortSupplyShare: number | null;
  top5BuyShare: number | null;
  /** Share of traced wallets known to be funded through a discriminating shared source. A LOWER BOUND; null (UNKNOWN) when too few funding histories are complete. */
  sharedFundingShare: number | null;
  /** Share of traced wallets whose funding relations are known (complete histories). */
  fundingKnownShare: number | null;
  tracedWallets: number;
  /** Share of cohort wallets that sit in a multi-signal group. */
  multiSignalWalletShare: number | null;
  /** Share of cohort wallets in a group that is significant after family-wise adjustment; null (UNKNOWN) when the inference could not run. */
  significantGroupWalletShare: number | null;
  maxFamilies: number;
  /** Share of the judged volume traded by wallets repeating balanced round trips (descriptive; market makers look the same). */
  motifVolumeShare: number | null;
  metronomicWallets: number;
  transferCycles: number;
}

export function extractCoordinationFeatures(r: CoordinationResult): CoordinationFeatures {
  const cohort = r.launch.cohort.length;
  const traced = r.funding.wallets.length;
  const disc = r.funding.shared.filter((s) => s.discriminating);
  const linked = new Set(disc.flatMap((s) => s.wallets)).size;
  const fundingKnownShare = traced > 0 ? r.funding.knownCount / traced : 0;
  const inGroups = new Set(r.cluster.groups.filter((g) => g.strength === "multi_signal").flatMap((g) => g.wallets));
  const W = r.wash;
  return {
    launchObserved: r.launch.launchObserved,
    dataComplete: !r.scopeLimited && r.coverage.signaturesComplete && r.coverage.transactionsMissing === 0 && r.funding.wallets.every((w) => !w.partial) && r.funding.notTraced.length === 0,
    cohortSize: cohort,
    cohortSupplyShare: r.launch.cohortSupplyShare,
    top5BuyShare: r.launch.top5BuyShare,
    sharedFundingShare: fundingKnownShare >= COORDINATION_RISK_DRAFT.minFundingKnownShare && traced >= 3 ? linked / traced : null,
    fundingKnownShare: traced > 0 ? fundingKnownShare : null,
    tracedWallets: traced,
    multiSignalWalletShare: cohort >= 3 ? inGroups.size / cohort : null,
    significantGroupWalletShare: r.cluster.inference.status === "ok" ? new Set(r.cluster.groups.filter((g) => g.significant).flatMap((g) => g.wallets)).size / Math.max(1, cohort) : null,
    maxFamilies: Math.max(0, ...r.cluster.groups.map((g) => g.families.length)),
    motifVolumeShare: W.motifVolumeShare,
    metronomicWallets: W.cadence.filter((c) => c.metronomic).length,
    transferCycles: W.transferCycles.length,
  };
}

export const COORDINATION_RISK_DRAFT = {
  version: "draft-0",
  weights: { launchConcentration: 25, sharedFunding: 25, coordinatedGroups: 25, volumePattern: 25 },
  /** Cohort supply share at which the concentration component is maxed. */
  supplyShareFullAt: 0.3,
  fundingShareFullAt: 0.5,
  groupShareFullAt: 0.4,
  motifVolumeFullAt: 0.3,
  minFundingKnownShare: 0.5,
  minComponents: 3,
  levels: { high: 60, medium: 30 },
} as const;

export interface CoordinationRiskComponent {
  key: string;
  label: string;
  points: number | null;
  max: number;
  note: string;
}

export interface CoordinationRiskDraft {
  version: string;
  status: "draft_unvalidated";
  score: number | null;
  level: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  components: CoordinationRiskComponent[];
  missing: string[];
  /** The inputs come from a partial history: the score is a lower bound at best. */
  partialData: boolean;
  interpretation: "indicators_of_coordinated_behaviour_not_intent_not_fraud";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const r1 = (x: number) => Math.round(x * 10) / 10;

export function scoreCoordinationRiskDraft(f: CoordinationFeatures, cfg = COORDINATION_RISK_DRAFT): CoordinationRiskDraft {
  const w = cfg.weights;
  const c: CoordinationRiskComponent[] = [];

  if (f.cohortSize < 3 || f.cohortSupplyShare === null) c.push({ key: "launchConcentration", label: "Concentration au lancement", points: null, max: w.launchConcentration, note: f.cohortSize < 3 ? "moins de 3 acheteurs de cohorte" : "offre totale inconnue" });
  else c.push({ key: "launchConcentration", label: "Concentration au lancement", points: r1(w.launchConcentration * clamp01(f.cohortSupplyShare / cfg.supplyShareFullAt)), max: w.launchConcentration, note: `cohorte = ${r1(f.cohortSupplyShare * 100)} % de l'offre${f.launchObserved ? "" : " (lancement non observé)"}` });

  c.push(
    f.sharedFundingShare === null
      ? { key: "sharedFunding", label: "Financement commun discriminant", points: null, max: w.sharedFunding, note: `UNKNOWN: financement connu pour ${f.fundingKnownShare === null ? "aucun" : r1(f.fundingKnownShare * 100) + " %"} des wallets tracés (seuil ${cfg.minFundingKnownShare * 100} %)` }
      : { key: "sharedFunding", label: "Financement commun discriminant", points: r1(w.sharedFunding * clamp01(f.sharedFundingShare / cfg.fundingShareFullAt)), max: w.sharedFunding, note: `au moins ${r1(f.sharedFundingShare * 100)} % de la cohorte tracée partage une source non neutre (borne inférieure)` },
  );

  c.push(
    f.significantGroupWalletShare === null
      ? { key: "coordinatedGroups", label: "Groupes significatifs", points: null, max: w.coordinatedGroups, note: "UNKNOWN: inférence impossible (financement connu pour trop peu de wallets)" }
      : { key: "coordinatedGroups", label: "Groupes significatifs", points: r1(w.coordinatedGroups * clamp01(f.significantGroupWalletShare / cfg.groupShareFullAt)), max: w.coordinatedGroups, note: `${r1(f.significantGroupWalletShare * 100)} % de la cohorte dans un groupe significatif après ajustement (${f.maxFamilies} familles au plus)` },
  );

  if (f.motifVolumeShare === null) c.push({ key: "volumePattern", label: "Motifs de volume", points: null, max: w.volumePattern, note: "volume non évalué" });
  else {
    const raw = clamp01(f.motifVolumeShare / cfg.motifVolumeFullAt) * 0.7 + (f.metronomicWallets > 0 ? 0.15 : 0) + (f.transferCycles > 0 ? 0.15 : 0);
    c.push({ key: "volumePattern", label: "Motifs de volume", points: r1(w.volumePattern * clamp01(raw)), max: w.volumePattern, note: `${r1(f.motifVolumeShare * 100)} % du volume par des wallets à aller-retours répétés équilibrés (teneurs de marché compris), ${f.metronomicWallets} wallet(s) réguliers, ${f.transferCycles} cycle(s)` });
  }

  const known = c.filter((x) => x.points !== null);
  const missing = c.filter((x) => x.points === null).map((x) => `${x.label}: ${x.note}`);
  const base = { version: cfg.version, status: "draft_unvalidated" as const, components: c, missing, partialData: !f.dataComplete, interpretation: "indicators_of_coordinated_behaviour_not_intent_not_fraud" as const };
  if (known.length < cfg.minComponents) return { ...base, score: null, level: "UNKNOWN" };
  const maxKnown = known.reduce((s, x) => s + x.max, 0);
  const score = r1((100 * known.reduce((s, x) => s + (x.points as number), 0)) / maxKnown);
  return { ...base, score, level: score >= cfg.levels.high ? "HIGH" : score >= cfg.levels.medium ? "MEDIUM" : "LOW" };
}
