/**
 * Records a depth report in the Evidence Ledger, keeping three kinds of content apart:
 *   observed   (pool state read from the chain)                       → FACT, derivation "observed"
 *   computed   (deterministic simulation from the observed state)     → FACT when the program source was
 *                                                                        read, INDICATION when only the
 *                                                                        vendor SDK was (PumpSwap)
 *   estimated  (simulation that is known to be incomplete: unread     → INDICATION, derivation "estimated"
 *               ticks, unsupported pool features, missing fee data)
 * The simulation is never presented as a guarantee of execution.
 */

import type { EvidenceLedger } from "../ledger.ts";
import type { EvidenceFact, EvidenceSource } from "../types.ts";
import type { DepthReport } from "./engine.ts";
import { DISCLAIMER } from "./engine.ts";
import type { BuiltVenue } from "./snapshot.ts";

export interface DepthEvidenceArgs {
  ledger: EvidenceLedger;
  /** The token analysed (base mint). */
  mint: string;
  report: DepthReport;
  built: BuiltVenue;
  /** When the accounts were read (ISO 8601 UTC). */
  observedAt: string;
  /** Slot of the consistent snapshot, when known. */
  slot: number | null;
  source?: EvidenceSource;
  /** Ids of entries the quote USD price comes from (e.g. a DEX Screener dex_pair entry). */
  priceEvidenceIds?: string[];
}

export interface DepthEvidenceIds {
  observed: string;
  depth: string;
  quoteControls: string | null;
}

const usd = (n: number | null | undefined): number | null => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const num = (n: number | null | undefined): number | null => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 1e6) / 1e6);
const f = (key: string, value: EvidenceFact["value"]): EvidenceFact => ({ key, value });

/** Flat facts of a report: finite numbers, strings and booleans only. */
export function depthFacts(r: DepthReport): EvidenceFact[] {
  const out: EvidenceFact[] = [f("venue", r.info.kind), f("formulaAssurance", r.info.formulaAssurance), f("quoteUsdSource", r.quote.source), f("quoteUsd", num(r.quote.usdPerQuote)), f("complete", r.complete)];
  for (const p of r.ask) out.push(f(`ask_${p.impactBps}bps_reached`, p.reached), f(`ask_${p.impactBps}bps_usd`, usd(p.input?.usd)));
  for (const p of r.bid) out.push(f(`bid_${p.impactBps}bps_reached`, p.reached), f(`bid_${p.impactBps}bps_quote_out_usd`, usd(p.output?.usd)), f(`bid_${p.impactBps}bps_base_in_usd`, usd(p.input?.usd)));
  out.push(f("exit_to_entry_ratio_1pct", num(r.exitToEntryRatio1Pct)));
  for (const t of r.buys) out.push(f(`${t.label.replace(/[^a-z0-9]+/gi, "_")}_ok`, t.ok), f(`${t.label.replace(/[^a-z0-9]+/gi, "_")}_exec_impact_pct`, num(t.executionImpactPct)));
  for (const t of r.supplySells) out.push(f(`${t.label.replace(/[^a-z0-9]+/gi, "_")}_ok`, t.ok), f(`${t.label.replace(/[^a-z0-9]+/gi, "_")}_out_usd`, usd(t.amountOut?.usd)), f(`${t.label.replace(/[^a-z0-9]+/gi, "_")}_capacity_usd`, usd(t.capacity?.output.usd)));
  for (const t of r.roundTrips) out.push(f(`round_trip_${t.usd}_ok`, t.ok), f(`round_trip_${t.usd}_loss_pct`, num(t.lossPct)));
  return out;
}

export function recordDepthEvidence(a: DepthEvidenceArgs): DepthEvidenceIds {
  const { ledger, mint, report, built } = a;
  const source = a.source ?? "solana_rpc";
  const pool = report.info.poolAddress;
  const observed = ledger.add({
    mint,
    type: "pool_state",
    source,
    status: "FACT",
    derivation: "observed",
    summary: `État du pool ${report.info.kind} ${pool} lu au slot ${a.slot ?? "inconnu"}`,
    facts: Object.entries(built.observed).map(([k, v]) => f(k, v)),
    observedAt: a.observedAt,
    slot: a.slot,
    addresses: [pool, report.info.baseMint, report.info.quoteMint],
    limits: ["instantané: l'état du pool change à chaque transaction", ...(report.info.dataComplete ? [] : ["toutes les données de liquidité n'ont pas été lues"])],
  });

  // Controls over the quote token matter for exits (its authorities can freeze, move or tax it).
  let quoteControls: string | null = null;
  const q = built.quoteMintData;
  if (q.freezeAuthority || q.permanentDelegate || q.mintAuthority || q.transferHookProgram) {
    quoteControls = ledger.add({
      mint,
      type: "mint_state",
      source,
      status: "FACT",
      derivation: "observed",
      summary: `Le token de cotation ${report.info.quoteMint} a des autorités actives (gel, delegate permanent ou mint)`,
      facts: [f("mintAuthority", q.mintAuthority), f("freezeAuthority", q.freezeAuthority), f("permanentDelegate", q.permanentDelegate), f("transferHookProgram", q.transferHookProgram), f("extensionTypes", q.extensionTypes.join(",")), f("transferFeeBpsNow", built.venue.info.fees.join(" | ").includes("quote 1 %") ? 100 : null)],
      observedAt: a.observedAt,
      slot: a.slot,
      addresses: [report.info.quoteMint],
      limits: ["la simulation de profondeur ignore ces contrôles: ils peuvent bloquer, taxer ou déplacer le token de cotation"],
    }).id;
  }

  const sourceKnown = report.info.formulaAssurance === "program_source";
  const estimated = !report.complete;
  const limits = [DISCLAIMER, ...report.info.assumptions, ...report.info.unsupported.map((u) => `non simulé: ${u}`), ...(report.info.dataComplete ? [] : ["liquidité au-delà des données chargées inconnue"]), `prix USD du token de cotation: ${report.quote.source}`, "les autres pools du token ne sont pas inclus"];
  if (!sourceKnown) limits.push("le code du programme n'est pas public: les formules sont celles du SDK officiel (reproduction exacte constatée sur des swaps réels récents, mais non garantie)");

  const depth = ledger.add({
    mint,
    type: "liquidity_depth",
    source,
    status: estimated || !sourceKnown ? "INDICATION" : "FACT",
    derivation: estimated ? "estimated" : "computed",
    summary: `${estimated ? "Estimation incomplète" : "Simulation déterministe"} de profondeur sur le pool ${report.info.kind} ${pool}`,
    facts: depthFacts(report),
    observedAt: a.observedAt,
    slot: a.slot,
    addresses: [pool],
    basedOn: [observed.id, ...(a.priceEvidenceIds ?? [])],
    limits,
  }).id;
  return { observed: observed.id, depth, quoteControls };
}
