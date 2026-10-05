/**
 * Descriptive report and flat export of tracked observations. No optimisation,
 * no outcome labels, no significance claims: counts, n and raw statistics only.
 */

import { CHECKPOINTS, observedPath } from "./tracker.ts";
import type { CheckpointKey, Observation } from "./tracker.ts";

const DECISIONS = ["MOMENTUM", "WATCH", "CAUTION", "AVOID", "NO SIGNAL"] as const;
const fmt = (x: number | null, digits = 1) => (x === null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(digits)} %`);

export interface Stats {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function stats(xs: number[]): Stats {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const m = Math.floor(v.length / 2);
  return { n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, median: v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, min: v[0], max: v[v.length - 1] };
}

const decisionReturnsAt = (obs: Observation[], key: CheckpointKey) => obs.map((o) => o.outcomes[key]?.status === "OK" ? o.outcomes[key]!.decisionReturnPct : null).filter((x): x is number => x !== null);
const marketReturnsAt = (obs: Observation[], key: CheckpointKey) => obs.map((o) => o.outcomes[key]?.status === "OK" ? o.outcomes[key]!.marketReturnPct : null).filter((x): x is number => x !== null);

/** Latency between the market observation (T0) and the decision, by depth of analysis (dataset quality, not trading). */
export const tierOf = (o: Observation) => (o.snapshot.funnel.step4Status !== "NOT_RUN" ? "Step 4" : o.snapshot.funnel.step3Status !== "NOT_RUN" ? "Step 3" : "Step 2 seul");
const pct = (xs: number[], q: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : null;
};
export function latencyLines(obs: Observation[]): string[] {
  const out: string[] = [];
  const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  for (const tier of ["Step 2 seul", "Step 3", "Step 4"]) {
    const l = obs.filter((o) => tierOf(o) === tier).map((o) => o.snapshot.timeline.decisionAvailableAt - o.snapshot.timeline.marketObservedAt);
    if (!l.length) continue;
    out.push(`${tier}: n=${l.length} · médiane ${secs(pct(l, 0.5))} · p95 ${secs(pct(l, 0.95))} · max ${secs(Math.max(...l))}`);
  }
  return out;
}
const line = (s: Stats) => (s.n ? `n=${s.n} · moyenne ${fmt(s.mean)} · médiane ${fmt(s.median)} · min ${fmt(s.min)} · max ${fmt(s.max)}` : "n=0");

export function formatReport(obs: Observation[], now: number): string {
  const out: string[] = [];
  out.push("OUTCOME TRACKER — rapport descriptif (aucune significativité statistique revendiquée)");
  out.push(`TOTAL OBSERVATIONS: ${obs.length}`);
  if (!obs.length) {
    out.push("Aucune observation : lancer d'abord `npm run outcomes:capture`.");
    return out.join("\n");
  }
  const f = obs.map((o) => o.snapshot.funnel);
  out.push("", "FUNNEL (à T0)");
  out.push(`vus par le scan DEX : ${f.length}`);
  out.push(`candidats (selectCandidates) : ${f.filter((x) => x.candidate).length}`);
  out.push(`Step 3 exécuté : ${f.filter((x) => x.step3Status !== "NOT_RUN").length} (COMPLETE ${f.filter((x) => x.step3Status === "COMPLETE").length}, PARTIAL ${f.filter((x) => x.step3Status === "PARTIAL").length}, FAILED ${f.filter((x) => x.step3Status === "FAILED").length})`);
  out.push(`Step 4 exécuté : ${f.filter((x) => x.step4Status !== "NOT_RUN").length} (COMPLETE ${f.filter((x) => x.step4Status === "COMPLETE").length}, PARTIAL ${f.filter((x) => x.step4Status === "PARTIAL").length}, FAILED ${f.filter((x) => x.step4Status === "FAILED").length})`);
  out.push(`FinalAssessment avec Step 3 et Step 4 : ${f.filter((x) => x.step3Status !== "NOT_RUN" && x.step4Status !== "NOT_RUN").length}`);

  out.push("", "BY FINAL DECISION");
  for (const d of DECISIONS) out.push(`${d}: ${obs.filter((o) => o.snapshot.final.decision === d).length}`);

  out.push("", "CHECKPOINT COVERAGE (OK / dus ; autres statuts)");
  for (const { key, ms } of CHECKPOINTS) {
    const due = obs.filter((o) => now >= o.snapshot.timeline.decisionAvailableAt + ms);
    const st = (s: string) => due.filter((o) => o.outcomes[key]?.status === s).length;
    const pending = due.filter((o) => !o.outcomes[key]).length;
    const delays = due.map((o) => o.outcomes[key]).filter((c) => c?.status === "OK").map((c) => c!.delayMs! / 60_000);
    const dl = stats(delays);
    out.push(`${key}: ${st("OK")}/${due.length} · UNAVAILABLE ${st("UNAVAILABLE")} · PROVIDER_ERROR ${st("PROVIDER_ERROR")} · MISSED ${st("MISSED")} · en attente ${pending}${dl.n ? ` · retard médian ${dl.median!.toFixed(1)} min (max ${dl.max!.toFixed(1)})` : ""}`);
  }

  out.push("", "DECISION LATENCY (decisionAvailableAt − marketObservedAt)", ...latencyLines(obs));
  out.push("", "DECISION RETURNS BY DECISION (vs prix à decisionAvailableAt ; checkpoints depuis decisionAvailableAt ; n faible = purement descriptif)");
  for (const d of DECISIONS) {
    const group = obs.filter((o) => o.snapshot.final.decision === d);
    if (!group.length) continue;
    out.push(`${d} (${group.length} observation(s))`);
    for (const { key } of CHECKPOINTS) out.push(`  ${key.padEnd(3)} ${line(stats(decisionReturnsAt(group, key)))}   [marché vs prix T0 : ${line(stats(marketReturnsAt(group, key)))}]`);
    const paths = group.map(observedPath).filter((p) => p.observedPoints > 0);
    out.push(`  décision, observé sur le chemin (checkpoints uniquement, pas un vrai ATH / drawdown) : max ${line(stats(paths.map((p) => p.maxObservedReturnPct!)))} | min ${line(stats(paths.map((p) => p.minObservedReturnPct!)))}`);
  }
  const noPrice = obs.filter((o) => o.snapshot.market.priceUsd === null).length;
  if (noPrice) out.push("", `${noPrice} observation(s) sans prix T0 : rendements marché inconnus (exclus des statistiques).`);
  const noDecisionPrice = obs.filter((o) => o.snapshot.decisionMarket.priceUsd === null).length;
  if (noDecisionPrice) out.push(`${noDecisionPrice} observation(s) sans prix à la décision : rendements décision inconnus (exclus des statistiques).`);
  return out.join("\n");
}

/** One flat row per observation: T0 signals next to raw outcomes, for later offline analysis. */
export function exportRows(obs: Observation[]): Record<string, string | number | boolean | null>[] {
  return obs.map((o) => {
    const s = o.snapshot;
    const p = observedPath(o);
    const row: Record<string, string | number | boolean | null> = {
      observationId: s.observationId, marketObservedAt: new Date(s.timeline.marketObservedAt).toISOString(), decisionAvailableAt: new Date(s.timeline.decisionAvailableAt).toISOString(),
      decisionLatencyMs: s.timeline.decisionAvailableAt - s.timeline.marketObservedAt, mint: s.identity.mint, pairAddress: s.identity.pairAddress, symbol: s.identity.symbol,
      decisionMarketStatus: s.decisionMarket.status, priceUsdDecision: s.decisionMarket.priceUsd,
      priceUsdT0: s.market.priceUsd, liquidityUsdT0: s.market.liquidityUsd, marketCapT0: s.market.marketCap, ageMinutesT0: s.market.ageMinutes,
      candidate: s.funnel.candidate, step3Status: s.funnel.step3Status, step4Status: s.funnel.step4Status,
      opportunity: s.step2.opportunity, dexRisk: s.step2.risk, dexQuality: s.step2.quality, dexConfidence: s.step2.confidence, dexLabel: s.step2.label,
      onchainRisk: s.step3?.risk ?? null, onchainConfidence: s.step3?.confidence ?? null, redFlags: s.step3 ? s.step3.redFlagKeys.join("|") : null,
      walletsTracked: s.step4?.tracked ?? null, walletsMeasured: s.step4?.measured ?? null, walletsUnknown: s.step4?.unknown ?? null,
      highQualityWithoutHighRiskFlags: s.step4?.highQualityWithoutHighRiskFlags ?? null, independentClusters: s.step4?.independentClusters ?? null,
      baseDecision: s.final.baseDecision, decision: s.final.decision, blockers: s.final.blockers.join("|"), cautions: s.final.cautions.join("|"),
      maxObservedReturnPct: p.maxObservedReturnPct, minObservedReturnPct: p.minObservedReturnPct,
    };
    for (const { key } of CHECKPOINTS) {
      const c = o.outcomes[key];
      row[`status_${key}`] = c?.status ?? null;
      row[`decisionReturn_${key}`] = c?.decisionReturnPct ?? null;
      row[`marketReturn_${key}`] = c?.marketReturnPct ?? null;
      row[`delayMin_${key}`] = c?.delayMs != null ? Math.round(c.delayMs / 6000) / 10 : null;
    }
    return row;
  });
}

export function toCsv(rows: Record<string, string | number | boolean | null>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: string | number | boolean | null) => (v === null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c] ?? null)).join(","))].join("\n");
}
