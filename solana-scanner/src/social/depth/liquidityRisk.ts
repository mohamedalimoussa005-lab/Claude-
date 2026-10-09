/**
 * Liquidity risk — DRAFT, NOT WIRED ANYWHERE.
 *
 * Prepares an independent score for the future: how hard it would be to EXIT a position in this
 * pool, from the depth simulations. It is separate from Opportunity, Risk, Quality, Confidence and
 * from the Evidence Data Confidence, and nothing in the scanner reads it.
 *
 * Status "draft_unvalidated": weights and thresholds below are proposals to be validated against
 * outcomes before any use. Higher = harder to exit. It says nothing about price direction and is not
 * a probability of loss. A component whose input is unknown is reported as unknown and never counted as 0.
 */

import type { DepthReport, SizedTrade } from "./engine.ts";
import type { BuiltVenue } from "./snapshot.ts";

export interface LiquidityFeatures {
  /** Can the pool absorb a sale of 5 % of the supply? null when not simulated. */
  sell5PctSupplyOk: boolean | null;
  /** Execution impact (percent) of that sale when it executes. */
  sell5PctExecutionImpactPct: number | null;
  /** Largest sale the pool can absorb when it cannot take the 5 % sale, in USD (null if unknown). */
  sell5PctCapacityUsd: number | null;
  /** Exit quote at −1 % over entry quote at +1 %. 1 = symmetric, near 0 = one-way pool. */
  exitToEntryRatio1Pct: number | null;
  /** Loss (percent) of buying then immediately selling $1,000 (null if not simulated). */
  roundTripLoss1000Pct: number | null;
  /** Largest Token-2022 transfer tax in force on the base or quote token, basis points. */
  transferTaxBps: number | null;
  /** Share of the priced quote reserves that cannot be paid out (PumpSwap boost), 0..1. */
  unpayableReserveShare: number | null;
  /** The quote token has live freeze / permanent-delegate / mint authorities. */
  quoteTokenHasControls: boolean | null;
  /** False when the simulation rests on unsupported features or unread data. */
  simulationComplete: boolean;
}

export interface LiquidityExtras {
  quoteTokenHasControls?: boolean | null;
  /** (virtual_quote_reserves + waiting fees) / effective quote reserves, for boosted PumpSwap pools. */
  unpayableReserveShare?: number | null;
  transferTaxBps?: number | null;
}

/** Inputs that come from the pool and token accounts rather than from the simulation. */
export function extrasFromBuilt(b: BuiltVenue): LiquidityExtras {
  const q = b.quoteMintData;
  const eff = b.observed["effectiveQuoteReserves"];
  const real = b.observed["realQuoteReserves"];
  const share = typeof eff === "string" && typeof real === "string" && BigInt(eff) > 0n ? 1 - Number(BigInt(real)) / Number(BigInt(eff)) : null;
  return {
    quoteTokenHasControls: q.freezeAuthority !== null || q.permanentDelegate !== null || q.mintAuthority !== null || q.transferHookProgram !== null,
    unpayableReserveShare: share,
    transferTaxBps: Math.max(b.venue.info.transferTaxBps.base, b.venue.info.transferTaxBps.quote),
  };
}

const find = (xs: SizedTrade[], needle: string) => xs.find((t) => t.label.includes(needle));

export function extractLiquidityFeatures(r: DepthReport, extras: LiquidityExtras = {}): LiquidityFeatures {
  const s5 = find(r.supplySells, "5%");
  const rt = r.roundTrips.find((x) => x.usd === 1000);
  return {
    sell5PctSupplyOk: s5 ? s5.ok : null,
    sell5PctExecutionImpactPct: s5?.ok ? s5.executionImpactPct : null,
    sell5PctCapacityUsd: s5 && !s5.ok ? (s5.capacity?.output.usd ?? 0) : null,
    exitToEntryRatio1Pct: r.exitToEntryRatio1Pct,
    roundTripLoss1000Pct: rt && rt.ok ? rt.lossPct : null,
    transferTaxBps: extras.transferTaxBps ?? null,
    unpayableReserveShare: extras.unpayableReserveShare ?? null,
    quoteTokenHasControls: extras.quoteTokenHasControls ?? null,
    simulationComplete: r.complete,
  };
}

export const LIQUIDITY_RISK_DRAFT = {
  version: "draft-0",
  /** Points per component; they sum to 100. */
  weights: { exitFeasibility: 40, asymmetry: 20, roundTripCost: 20, controls: 20 },
  /** Execution impact (percent) of the 5 % sale at which that component is maximal. */
  exitImpactFullAtPct: 50,
  /** Round-trip loss (percent) at which that component is maximal. */
  roundTripFullAtPct: 20,
  /** Transfer tax (bps) at which the tax part of "controls" is maximal. */
  taxFullAtBps: 500,
  controlsSplit: { tax: 8, unpayable: 7, quoteControls: 5 },
  levels: { high: 60, medium: 30 },
  /** Minimum number of measurable components to output a score. */
  minComponents: 3,
} as const;

export interface LiquidityRiskComponent {
  key: "exitFeasibility" | "asymmetry" | "roundTripCost" | "controls";
  label: string;
  /** null = unknown input, not counted. */
  points: number | null;
  max: number;
  note: string;
}

export interface LiquidityRiskDraft {
  version: string;
  status: "draft_unvalidated";
  /** null when too few components are measurable. */
  score: number | null;
  level: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  components: LiquidityRiskComponent[];
  missing: string[];
  /** The score rests on an incomplete simulation. */
  estimated: boolean;
  interpretation: "exit_difficulty_from_simulation_not_a_probability_of_loss";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const r1 = (x: number) => Math.round(x * 10) / 10;

export function scoreLiquidityRiskDraft(f: LiquidityFeatures, cfg = LIQUIDITY_RISK_DRAFT): LiquidityRiskDraft {
  const w = cfg.weights;
  const c: LiquidityRiskComponent[] = [];

  // 1. Exit feasibility: can a 5 % sale execute, and at what execution impact?
  if (f.sell5PctSupplyOk === null) c.push({ key: "exitFeasibility", label: "Faisabilité de sortie", points: null, max: w.exitFeasibility, note: "vente de 5 % de la supply non simulée" });
  else if (!f.sell5PctSupplyOk) c.push({ key: "exitFeasibility", label: "Faisabilité de sortie", points: w.exitFeasibility, max: w.exitFeasibility, note: `la vente de 5 % de la supply ne peut pas s'exécuter (capacité ${f.sell5PctCapacityUsd === null ? "inconnue" : `$${r1(f.sell5PctCapacityUsd)}`})` });
  else if (f.sell5PctExecutionImpactPct === null) c.push({ key: "exitFeasibility", label: "Faisabilité de sortie", points: null, max: w.exitFeasibility, note: "impact d'exécution inconnu" });
  else c.push({ key: "exitFeasibility", label: "Faisabilité de sortie", points: r1(w.exitFeasibility * clamp01(f.sell5PctExecutionImpactPct / cfg.exitImpactFullAtPct)), max: w.exitFeasibility, note: `impact d'exécution de la vente de 5 %: ${r1(f.sell5PctExecutionImpactPct)} %` });

  // 2. Asymmetry between entering and exiting at ±1 %.
  c.push(
    f.exitToEntryRatio1Pct === null
      ? { key: "asymmetry", label: "Asymétrie entrée / sortie", points: null, max: w.asymmetry, note: "ratio sortie / entrée inconnu" }
      : { key: "asymmetry", label: "Asymétrie entrée / sortie", points: r1(w.asymmetry * clamp01(1 - f.exitToEntryRatio1Pct)), max: w.asymmetry, note: `sortie à −1 % / entrée à +1 % = ${f.exitToEntryRatio1Pct.toPrecision(3)}` },
  );

  // 3. Cost of an immediate round trip of $1,000.
  c.push(
    f.roundTripLoss1000Pct === null
      ? { key: "roundTripCost", label: "Coût d'un aller-retour de 1 000 $", points: null, max: w.roundTripCost, note: "aller-retour non exécutable ou non simulé" }
      : { key: "roundTripCost", label: "Coût d'un aller-retour de 1 000 $", points: r1(w.roundTripCost * clamp01(f.roundTripLoss1000Pct / cfg.roundTripFullAtPct)), max: w.roundTripCost, note: `perte ${r1(f.roundTripLoss1000Pct)} %` },
  );

  // 4. Controls: transfer tax, reserves priced but not payable, quote-token authorities. Each part counts only when known.
  const parts: { pts: number; max: number; text: string }[] = [];
  if (f.transferTaxBps !== null) parts.push({ pts: cfg.controlsSplit.tax * clamp01(f.transferTaxBps / cfg.taxFullAtBps), max: cfg.controlsSplit.tax, text: `taxe de transfert ${f.transferTaxBps / 100} %` });
  if (f.unpayableReserveShare !== null) parts.push({ pts: cfg.controlsSplit.unpayable * clamp01(f.unpayableReserveShare), max: cfg.controlsSplit.unpayable, text: `réserves non payables ${r1(f.unpayableReserveShare * 100)} %` });
  if (f.quoteTokenHasControls !== null) parts.push({ pts: f.quoteTokenHasControls ? cfg.controlsSplit.quoteControls : 0, max: cfg.controlsSplit.quoteControls, text: f.quoteTokenHasControls ? "autorités actives sur le token de cotation" : "pas d'autorité active sur le token de cotation" });
  if (parts.length === 0) c.push({ key: "controls", label: "Contrôles et taxes", points: null, max: w.controls, note: "aucune information" });
  else {
    const maxKnown = parts.reduce((s, p) => s + p.max, 0);
    c.push({ key: "controls", label: "Contrôles et taxes", points: r1((w.controls * parts.reduce((s, p) => s + p.pts, 0)) / maxKnown), max: w.controls, note: parts.map((p) => p.text).join("; ") });
  }

  const known = c.filter((x) => x.points !== null);
  const missing = c.filter((x) => x.points === null).map((x) => `${x.label}: ${x.note}`);
  if (known.length < cfg.minComponents) {
    return { version: cfg.version, status: "draft_unvalidated", score: null, level: "UNKNOWN", components: c, missing, estimated: !f.simulationComplete, interpretation: "exit_difficulty_from_simulation_not_a_probability_of_loss" };
  }
  const maxKnown = known.reduce((s, x) => s + x.max, 0);
  const score = r1((100 * known.reduce((s, x) => s + (x.points as number), 0)) / maxKnown);
  const level = score >= cfg.levels.high ? "HIGH" : score >= cfg.levels.medium ? "MEDIUM" : "LOW";
  return { version: cfg.version, status: "draft_unvalidated", score, level, components: c, missing, estimated: !f.simulationComplete, interpretation: "exit_difficulty_from_simulation_not_a_probability_of_loss" };
}
