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
  syncUnusual: boolean | null;
  /** Largest share of the traced cohort funded through one discriminating source. */
  sharedFundingShare: number | null;
  tracedWallets: number;
  /** Share of cohort wallets that sit in a multi-signal group. */
  multiSignalWalletShare: number | null;
  /** Share of cohort wallets in a group that chance alone (rest of the cohort, shuffled families) would rarely produce (p < alpha). */
  significantGroupWalletShare: number | null;
  maxFamilies: number;
  /** Round-trip share minus the 95th percentile of the permutation null; null if not computed. */
  roundTripExcess: number | null;
  metronomicWallets: number;
  transferCycles: number;
}

export function extractCoordinationFeatures(r: CoordinationResult): CoordinationFeatures {
  const cohort = r.launch.cohort.length;
  const traced = r.funding.wallets.length;
  const disc = r.funding.shared.filter((s) => s.discriminating);
  const inGroups = new Set(r.cluster.groups.filter((g) => g.strength === "multi_signal").flatMap((g) => g.wallets));
  const W = r.wash;
  return {
    launchObserved: r.launch.launchObserved,
    dataComplete: !r.scopeLimited && r.coverage.signaturesComplete && r.coverage.transactionsMissing === 0 && r.funding.wallets.every((w) => !w.partial) && r.funding.notTraced.length === 0,
    cohortSize: cohort,
    cohortSupplyShare: r.launch.cohortSupplyShare,
    top5BuyShare: r.launch.top5BuyShare,
    syncUnusual: cohort >= 3 ? r.launch.sync.unusual : null,
    sharedFundingShare: traced >= 3 && r.funding.unavailable.length < traced ? Math.max(0, ...disc.map((s) => s.cohortShare)) : null,
    tracedWallets: traced,
    multiSignalWalletShare: cohort >= 3 ? inGroups.size / cohort : null,
    significantGroupWalletShare: cohort >= 6 ? new Set(r.cluster.groups.filter((g) => g.strength === "multi_signal" && g.pValue !== null && g.pValue < 0.01).flatMap((g) => g.wallets)).size / cohort : null,
    maxFamilies: Math.max(0, ...r.cluster.groups.map((g) => g.families.length)),
    roundTripExcess: W.roundTripShare !== null && W.permutation ? W.roundTripShare - W.permutation.nullP95 : null,
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
  roundTripExcessFullAt: 0.3,
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
  else {
    const base = clamp01(f.cohortSupplyShare / cfg.supplyShareFullAt) * 0.8 + (f.syncUnusual ? 0.2 : 0);
    c.push({ key: "launchConcentration", label: "Concentration au lancement", points: r1(w.launchConcentration * clamp01(base)), max: w.launchConcentration, note: `cohorte = ${r1(f.cohortSupplyShare * 100)} % de l'offre${f.syncUnusual ? ", synchronie inhabituelle" : ""}${f.launchObserved ? "" : " (lancement non observé)"}` });
  }

  c.push(
    f.sharedFundingShare === null
      ? { key: "sharedFunding", label: "Financement commun discriminant", points: null, max: w.sharedFunding, note: "financements non remontés pour assez de wallets" }
      : { key: "sharedFunding", label: "Financement commun discriminant", points: r1(w.sharedFunding * clamp01(f.sharedFundingShare / cfg.fundingShareFullAt)), max: w.sharedFunding, note: `${r1(f.sharedFundingShare * 100)} % de la cohorte tracée partage une source non neutre` },
  );

  c.push(
    f.significantGroupWalletShare === null
      ? { key: "coordinatedGroups", label: "Groupes à signaux multiples", points: null, max: w.coordinatedGroups, note: "cohorte trop petite pour le modèle nul" }
      : { key: "coordinatedGroups", label: "Groupes à signaux multiples", points: r1(w.coordinatedGroups * clamp01(f.significantGroupWalletShare / cfg.groupShareFullAt)), max: w.coordinatedGroups, note: `${r1(f.significantGroupWalletShare * 100)} % de la cohorte dans un groupe au-dessus du hasard (${r1((f.multiSignalWalletShare ?? 0) * 100)} % dans un groupe, significatif ou non; ${f.maxFamilies} familles au plus)` },
  );

  if (f.roundTripExcess === null) c.push({ key: "volumePattern", label: "Motifs de volume", points: null, max: w.volumePattern, note: "volume non évalué" });
  else {
    const raw = clamp01(Math.max(0, f.roundTripExcess) / cfg.roundTripExcessFullAt) * 0.7 + (f.metronomicWallets > 0 ? 0.15 : 0) + (f.transferCycles > 0 ? 0.15 : 0);
    c.push({ key: "volumePattern", label: "Motifs de volume", points: r1(w.volumePattern * clamp01(raw)), max: w.volumePattern, note: `aller-retours ${f.roundTripExcess >= 0 ? "+" : ""}${r1(f.roundTripExcess * 100)} pts au-dessus du modèle nul, ${f.metronomicWallets} wallet(s) réguliers, ${f.transferCycles} cycle(s)` });
  }

  const known = c.filter((x) => x.points !== null);
  const missing = c.filter((x) => x.points === null).map((x) => `${x.label}: ${x.note}`);
  const base = { version: cfg.version, status: "draft_unvalidated" as const, components: c, missing, partialData: !f.dataComplete, interpretation: "indicators_of_coordinated_behaviour_not_intent_not_fraud" as const };
  if (known.length < cfg.minComponents) return { ...base, score: null, level: "UNKNOWN" };
  const maxKnown = known.reduce((s, x) => s + x.max, 0);
  const score = r1((100 * known.reduce((s, x) => s + (x.points as number), 0)) / maxKnown);
  return { ...base, score, level: score >= cfg.levels.high ? "HIGH" : score >= cfg.levels.medium ? "MEDIUM" : "LOW" };
}
