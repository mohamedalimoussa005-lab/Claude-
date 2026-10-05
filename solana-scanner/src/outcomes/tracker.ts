/**
 * Outcome Tracker V1 — an observation layer over the scanner, never an input to it.
 *
 * An observation = an IMMUTABLE snapshot of what the scanner knew (market data at T0,
 * Step 2 / 3 / 4 results, FinalAssessment, the timeline of that analysis and the market
 * when the decision became available) + outcomes measured later on the SAME pair at fixed
 * checkpoints after `decisionAvailableAt` (schema v2). Step 3 / 4 can finish minutes after
 * the DEX scan: outcomes are anchored on the moment the recorded decision existed, never on
 * the scan time, so no information acquired after T0 is credited to T0. Outcomes are only ever added next to the snapshot: nothing in
 * the snapshot is recomputed with later data, and nothing here feeds back into the
 * scanner. Pure: no I/O, the caller supplies time and fetch results.
 */

import { createHash } from "node:crypto";
import type { NormalizedPair } from "../domain/normalize.ts";
import type { FinalAssessment } from "../final/assessment.ts";
import type { OnchainResult } from "../onchain/service.ts";
import type { PairScore } from "../scoring/score.ts";
import type { WalletIntel } from "../wallets/intel.ts";

export const SCHEMA_VERSION = 2;
/** v1 datasets (capturedAt-anchored, no timeline) are legacy: never read as v2, never migrated with invented times. */
export const LEGACY_SCHEMA_VERSIONS = [1];
export const CHECKPOINTS = [
  { key: "5m", ms: 5 * 60_000 },
  { key: "15m", ms: 15 * 60_000 },
  { key: "30m", ms: 30 * 60_000 },
  { key: "1h", ms: 60 * 60_000 },
  { key: "3h", ms: 3 * 60 * 60_000 },
  { key: "6h", ms: 6 * 60 * 60_000 },
  { key: "12h", ms: 12 * 60 * 60_000 },
  { key: "24h", ms: 24 * 60 * 60_000 },
] as const;
export type CheckpointKey = (typeof CHECKPOINTS)[number]["key"];

export type EngineStatus = "NOT_RUN" | "COMPLETE" | "PARTIAL" | "FAILED";
/**
 * OK — exact T0 pair returned with its data; UNAVAILABLE — the provider answered without that pair;
 * PROVIDER_ERROR — the request failed; MISSED — the checkpoint window passed without a usable fetch.
 * A checkpoint that is not stored yet is NOT_DUE (or due but not fetched yet). None of these implies a price of 0.
 */
export type CheckpointStatus = "OK" | "UNAVAILABLE" | "PROVIDER_ERROR" | "MISSED";

/** When each part of the analysis happened (null = that engine did not run; never back-filled). */
export interface Timeline {
  /** The capture command started (before the DEX scan). */
  captureStartedAt: number;
  /** T0: the DEX scan whose market data the scanner used. */
  marketObservedAt: number;
  step2CompletedAt: number;
  step3StartedAt: number | null;
  step3CompletedAt: number | null;
  step4StartedAt: number | null;
  step4CompletedAt: number | null;
  /** The FinalAssessment recorded in this snapshot was produced. */
  assessmentCompletedAt: number;
  /** First instant the recorded decision existed (= assessmentCompletedAt): base of every outcome checkpoint. */
  decisionAvailableAt: number;
  snapshotFinalizedAt: number;
}

/** The exact T0 pair fetched right after the decision became available: base of decisionReturnPct. */
export interface DecisionMarket {
  status: "OK" | "UNAVAILABLE" | "PROVIDER_ERROR";
  observedAt: number;
  provider: "dexscreener";
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  note: string | null;
}

export interface Snapshot {
  schemaVersion: number;
  observationId: string;
  /** = timeline.marketObservedAt (T0 of the market data); kept for the id. Not the decision time. */
  capturedAt: number;
  timeline: Timeline;
  decisionMarket: DecisionMarket;
  source: "dexscreener";
  scannerCommit: string | null;
  identity: { mint: string; pairAddress: string; chainId: string; dexId: string | null; symbol: string | null; name: string | null; quoteSymbol: string | null; url: string | null };
  market: {
    priceUsd: number | null;
    liquidityUsd: number | null;
    marketCap: number | null;
    fdv: number | null;
    volumeM5: number | null;
    volumeH1: number | null;
    volumeH6: number | null;
    volumeH24: number | null;
    buysM5: number | null;
    sellsM5: number | null;
    buysH1: number | null;
    sellsH1: number | null;
    priceChangeM5: number | null;
    priceChangeH1: number | null;
    priceChangeH6: number | null;
    pairCreatedAt: number | null;
    ageMinutes: number | null;
  };
  /** Which part of the pipeline this token reached at T0 (nothing is forced). */
  funnel: { seenInScan: true; candidate: boolean; step3Status: EngineStatus; step4Status: EngineStatus; finalAssessment: true };
  step2: { opportunity: number; risk: number; quality: number; confidence: string; label: string | null; labelReason: string; categories: Record<string, number>; riskFactorKeys: string[]; missingFields: string[] };
  step3: null | {
    risk: number;
    confidence: string;
    mintAuthority: string;
    freezeAuthority: string;
    tokenProgram: string | null;
    riskyExtensions: string[];
    redFlagKeys: string[];
    redFlags: string[];
    positives: string[];
    unknowns: string[];
    sections: Record<string, string>;
    holders: { count: number; top10Raw: number; top10Adjusted: number | null } | null;
    creator: string | null;
    relatedGroups: number;
    strongLinks: number;
    linkCounts: Record<string, number>;
  };
  step4: null | {
    analysisStatus: string;
    buyersIdentified: number;
    tracked: number;
    measured: number;
    unknown: number;
    unknownByReason: Record<string, number>;
    highQuality: number;
    highQualityMeasured: number;
    highQualityWithoutHighRiskFlags: number;
    highConfidence: number;
    highConfidenceData: number;
    independentClusters: number;
    linkCounts: Record<string, number>;
    creatorLinks: Record<string, number>;
  };
  final: Pick<FinalAssessment, "decision" | "baseDecision" | "baseDexLabel" | "dataConfidence" | "why" | "positives" | "negatives" | "uncertainties" | "informational"> & { blockers: string[]; cautions: string[] };
}

export interface Checkpoint {
  key: CheckpointKey;
  targetAt: number;
  status: CheckpointStatus;
  /** Time of the fetch that produced this record (never the target time); null for MISSED. */
  observedAt: number | null;
  /** observedAt − targetAt. */
  delayMs: number | null;
  provider: "dexscreener";
  attempts: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volumeH1: number | null;
  volumeH24: number | null;
  /** Primary: (price / decisionMarket price − 1) × 100; null when either price is unknown. */
  decisionReturnPct: number | null;
  /** Secondary: (price / T0 scan price − 1) × 100 at the same checkpoint; null when either price is unknown. */
  marketReturnPct: number | null;
  note: string | null;
}

export interface Observation {
  snapshot: Snapshot;
  /** sha256 of the snapshot at capture: any later change is detected and refused. */
  snapshotHash: string;
  outcomes: Partial<Record<CheckpointKey, Checkpoint>>;
}

export type FetchResult = { status: "OK"; pair: NormalizedPair } | { status: "UNAVAILABLE" } | { status: "PROVIDER_ERROR"; error: string };

// ─── snapshot ──────────────────────────────────────────────────────────────

const num = (x: number | null | undefined): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Deterministic JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const hashSnapshot = (s: Snapshot): string => createHash("sha256").update(canonical(s)).digest("hex");

export const observationIdOf = (mint: string, pairAddress: string, capturedAt: number) => `${mint}:${pairAddress}:${capturedAt}`;

const countBy = <T>(xs: T[], k: (x: T) => string): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});

export interface CaptureInput {
  pair: NormalizedPair;
  score: PairScore;
  assessment: FinalAssessment;
  timeline: Timeline;
  decisionMarket: DecisionMarket;
  candidate: boolean;
  onchain: OnchainResult | null;
  step3Status: EngineStatus;
  wallets: WalletIntel | null;
  step4Status: EngineStatus;
  scannerCommit?: string | null;
}

/** Market state of the exact pair when the decision became available (never the T0 price reused). */
export function decisionMarketFrom(pairAddress: string, fetch: FetchResult, observedAt: number): DecisionMarket {
  if (fetch.status === "OK") {
    if (fetch.pair.pairAddress !== pairAddress) throw new Error("decision market fetch for another pair: no silent substitution");
    const p = fetch.pair;
    const price = num(p.priceUsd);
    return { status: "OK", observedAt, provider: "dexscreener", priceUsd: price, liquidityUsd: num(p.liquidityUsd), marketCap: num(p.marketCap), fdv: num(p.fdv), note: price === null ? "prix absent dans la réponse" : null };
  }
  return { status: fetch.status, observedAt, provider: "dexscreener", priceUsd: null, liquidityUsd: null, marketCap: null, fdv: null, note: fetch.status === "PROVIDER_ERROR" ? `erreur fournisseur : ${fetch.error.slice(0, 160)}` : "paire absente de la réponse du fournisseur" };
}

/** Chronology invariants: no recorded decision may predate the data it used. */
export function checkTimeline(t: Timeline, step3Ran: boolean, step4Ran: boolean, dm: DecisionMarket): void {
  const fail = (m: string) => {
    throw new Error(`timeline invalide : ${m}`);
  };
  if (t.marketObservedAt < t.captureStartedAt) fail("marketObservedAt < captureStartedAt");
  if (t.step2CompletedAt < t.marketObservedAt) fail("step2CompletedAt < marketObservedAt");
  for (const [ran, a, b, n] of [[step3Ran, t.step3StartedAt, t.step3CompletedAt, "step3"], [step4Ran, t.step4StartedAt, t.step4CompletedAt, "step4"]] as const) {
    if (!ran && (a !== null || b !== null)) fail(`${n} non exécuté mais horodaté`);
    if (ran && (a === null || b === null || a < t.step2CompletedAt || b < a)) fail(`${n} mal horodaté`);
  }
  const used = [t.step2CompletedAt, t.step3CompletedAt, t.step4CompletedAt].filter((x): x is number => x !== null);
  if (t.assessmentCompletedAt < Math.max(...used)) fail("assessmentCompletedAt antérieur à une donnée utilisée");
  if (t.decisionAvailableAt !== t.assessmentCompletedAt) fail("decisionAvailableAt ≠ assessmentCompletedAt");
  if (dm.observedAt < t.decisionAvailableAt) fail("decisionMarket observé avant la décision");
  if (t.snapshotFinalizedAt < dm.observedAt) fail("snapshotFinalizedAt antérieur au decisionMarket");
}

/** Builds the snapshot from results the scanner already computed (no scoring here). */
export function buildObservation(i: CaptureInput): Observation {
  const { pair: p, score: s, assessment: fa } = i;
  checkTimeline(i.timeline, i.step3Status !== "NOT_RUN", i.step4Status !== "NOT_RUN", i.decisionMarket);
  const a = i.onchain?.analysis ?? null;
  const d = i.onchain?.data ?? null;
  const w = i.wallets;
  const snapshot: Snapshot = {
    schemaVersion: SCHEMA_VERSION,
    observationId: observationIdOf(p.tokenAddress, p.pairAddress, i.timeline.marketObservedAt),
    capturedAt: i.timeline.marketObservedAt,
    timeline: { ...i.timeline },
    decisionMarket: { ...i.decisionMarket },
    source: "dexscreener",
    scannerCommit: i.scannerCommit ?? null,
    identity: { mint: p.tokenAddress, pairAddress: p.pairAddress, chainId: p.chainId, dexId: p.dexId, symbol: p.tokenSymbol, name: p.tokenName, quoteSymbol: p.quoteSymbol, url: p.url },
    market: {
      priceUsd: num(p.priceUsd), liquidityUsd: num(p.liquidityUsd), marketCap: num(p.marketCap), fdv: num(p.fdv),
      volumeM5: num(p.volumeM5), volumeH1: num(p.volumeH1), volumeH6: num(p.volumeH6), volumeH24: num(p.volumeH24),
      buysM5: num(p.buysM5), sellsM5: num(p.sellsM5), buysH1: num(p.buysH1), sellsH1: num(p.sellsH1),
      priceChangeM5: num(p.priceChangeM5), priceChangeH1: num(p.priceChangeH1), priceChangeH6: num(p.priceChangeH6),
      pairCreatedAt: num(p.pairCreatedAt), ageMinutes: num(s.ageMinutes),
    },
    funnel: { seenInScan: true, candidate: i.candidate, step3Status: i.step3Status, step4Status: i.step4Status, finalAssessment: true },
    step2: {
      opportunity: s.opportunity, risk: s.risk, quality: s.quality, confidence: s.confidence.level, label: s.label, labelReason: s.labelReason,
      categories: Object.fromEntries(Object.entries(s.categories ?? {}).map(([k, c]) => [k, c.points])),
      riskFactorKeys: (s.riskFactors ?? []).map((f) => f.key), missingFields: [...(s.missingFields ?? [])],
    },
    step3: a
      ? {
          risk: a.risk, confidence: a.confidence, mintAuthority: a.mintAuthority, freezeAuthority: a.freezeAuthority, tokenProgram: a.tokenProgram,
          riskyExtensions: [...a.riskyExtensions], redFlagKeys: a.redFlagFacts.map((f) => f.key), redFlags: [...a.redFlags], positives: [...a.positives], unknowns: [...a.unknowns],
          sections: d ? Object.fromEntries((["mintInfo", "holders", "owners", "creator", "creatorActivity", "wallets"] as const).map((k) => [k, d[k].status])) : {},
          holders: a.holders ? { count: a.holders.holderCount, top10Raw: a.holders.raw.top10, top10Adjusted: a.holders.adjusted?.top10 ?? null } : null,
          creator: a.creator?.address ?? null, relatedGroups: a.related?.groups.length ?? 0, strongLinks: a.related?.strongLinks ?? 0,
          linkCounts: countBy(a.related?.links ?? [], (l) => l.type),
        }
      : null,
    step4: w
      ? {
          analysisStatus: w.analysisStatus, buyersIdentified: w.buyersIdentified, tracked: w.tracked.length, measured: w.measured, unknown: w.unknown, unknownByReason: { ...w.unknownByReason },
          highQuality: w.highQuality, highQualityMeasured: w.highQualityMeasured, highQualityWithoutHighRiskFlags: w.highQualityWithoutHighRiskFlags,
          highConfidence: w.highConfidence, highConfidenceData: w.highConfidenceData, independentClusters: w.independentClusters,
          linkCounts: countBy(w.related.links, (l) => l.type),
          creatorLinks: countBy(w.tracked.filter((t) => t.profile.creatorLink), (t) => `${t.profile.creatorLink!.type}/${t.profile.creatorLink!.strength}`),
        }
      : null,
    final: {
      decision: fa.decision, baseDecision: fa.baseDecision, baseDexLabel: fa.baseDexLabel, dataConfidence: fa.dataConfidence, why: [...fa.why],
      blockers: fa.blockers.map((r) => r.fact), cautions: fa.cautions.map((r) => r.fact),
      positives: fa.positives, negatives: fa.negatives, uncertainties: fa.uncertainties, informational: fa.informational,
    },
  };
  // Detach from the scanner's objects: the stored snapshot shares nothing mutable with them.
  const frozen = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  return { snapshot: frozen, snapshotHash: hashSnapshot(frozen), outcomes: {} };
}

// ─── checkpoints ───────────────────────────────────────────────────────────

/** Checkpoints are anchored on decisionAvailableAt (never on the scan time). */
export const decisionBase = (s: Snapshot) => s.timeline.decisionAvailableAt;
export const targetOf = (s: Snapshot, key: CheckpointKey) => decisionBase(s) + CHECKPOINTS.find((c) => c.key === key)!.ms;

/**
 * A checkpoint can be measured from its target time until the next checkpoint's target
 * (the last one: any time after). Outside that window a measurement would describe
 * another horizon, so an unmeasured checkpoint whose window has passed becomes MISSED.
 */
export function windowOf(s: Snapshot, key: CheckpointKey): { from: number; until: number | null } {
  const i = CHECKPOINTS.findIndex((c) => c.key === key);
  return { from: decisionBase(s) + CHECKPOINTS[i].ms, until: i + 1 < CHECKPOINTS.length ? decisionBase(s) + CHECKPOINTS[i + 1].ms : null };
}

export type CheckpointState = "NOT_DUE" | "DUE" | "FINAL" | "WINDOW_PASSED";

export function checkpointState(o: Observation, key: CheckpointKey, now: number): CheckpointState {
  const cp = o.outcomes[key];
  if (cp && (cp.status === "OK" || cp.status === "MISSED")) return "FINAL";
  const w = windowOf(o.snapshot, key);
  if (now < w.from) return "NOT_DUE";
  if (w.until !== null && now >= w.until) return "WINDOW_PASSED";
  return "DUE";
}

/** Checkpoints a fetch at `now` may fill (UNAVAILABLE / PROVIDER_ERROR are retried while their window is open). */
export const dueCheckpoints = (o: Observation, now: number): CheckpointKey[] => CHECKPOINTS.map((c) => c.key).filter((k) => checkpointState(o, k, now) === "DUE");

export function returnPct(price0: number | null, price: number | null): number | null {
  if (price0 === null || price === null || !Number.isFinite(price0) || !Number.isFinite(price) || price0 <= 0 || price < 0) return null;
  const r = (price / price0 - 1) * 100;
  return Number.isFinite(r) ? r : null;
}

/**
 * Applies one fetch made at `now` to the due checkpoints and closes passed windows.
 * Returns a new observation; the snapshot is carried over untouched and verified by hash.
 */
export function applyFetch(o: Observation, now: number, fetch: FetchResult | null): Observation {
  if (hashSnapshot(o.snapshot) !== o.snapshotHash) throw new Error(`snapshot ${o.snapshot.observationId} changed after capture: refused`);
  const outcomes = { ...o.outcomes };
  for (const { key } of CHECKPOINTS) {
    const state = checkpointState(o, key, now);
    const prev = outcomes[key];
    if (state === "WINDOW_PASSED") {
      // Keep the last failed attempt (UNAVAILABLE / PROVIDER_ERROR) as is; never invent a price.
      if (!prev) outcomes[key] = empty(o.snapshot, key, "MISSED", null, 0, "fenêtre du checkpoint passée sans mesure");
      continue;
    }
    if (state !== "DUE" || !fetch) continue;
    const attempts = (prev?.attempts ?? 0) + 1;
    if (fetch.status === "OK") {
      const p = fetch.pair;
      if (p.pairAddress !== o.snapshot.identity.pairAddress) throw new Error("fetch for another pair: no silent substitution");
      const price = num(p.priceUsd);
      outcomes[key] = {
        key, targetAt: targetOf(o.snapshot, key), status: "OK", observedAt: now, delayMs: now - targetOf(o.snapshot, key), provider: "dexscreener", attempts,
        priceUsd: price, liquidityUsd: num(p.liquidityUsd), marketCap: num(p.marketCap), fdv: num(p.fdv), volumeH1: num(p.volumeH1), volumeH24: num(p.volumeH24),
        decisionReturnPct: o.snapshot.decisionMarket.status === "OK" ? returnPct(o.snapshot.decisionMarket.priceUsd, price) : null,
        marketReturnPct: returnPct(o.snapshot.market.priceUsd, price),
        note:
          price === null
            ? "prix absent dans la réponse"
            : o.snapshot.decisionMarket.priceUsd === null
              ? `prix à la décision inconnu (${o.snapshot.decisionMarket.status}) : rendement décision inconnu`
              : o.snapshot.market.priceUsd === null
                ? "prix T0 absent : rendement marché inconnu"
                : null,
      };
    } else {
      outcomes[key] = empty(o.snapshot, key, fetch.status, now, attempts, fetch.status === "PROVIDER_ERROR" ? `erreur fournisseur : ${fetch.error.slice(0, 160)}` : "paire absente de la réponse du fournisseur");
    }
  }
  return { snapshot: o.snapshot, snapshotHash: o.snapshotHash, outcomes };
}

function empty(s: Snapshot, key: CheckpointKey, status: CheckpointStatus, now: number | null, attempts: number, note: string): Checkpoint {
  const targetAt = targetOf(s, key);
  return { key, targetAt, status, observedAt: now, delayMs: now === null ? null : now - targetAt, provider: "dexscreener", attempts, priceUsd: null, liquidityUsd: null, marketCap: null, fdv: null, volumeH1: null, volumeH24: null, decisionReturnPct: null, marketReturnPct: null, note };
}

/** Path metrics of decisionReturnPct over the checkpoints actually observed: not a true high / low between them. */
export function observedPath(o: Observation): { maxObservedReturnPct: number | null; maxObservedAt: number | null; minObservedReturnPct: number | null; minObservedAt: number | null; observedPoints: number } {
  const pts = Object.values(o.outcomes).filter((c): c is Checkpoint => !!c && c.status === "OK" && c.decisionReturnPct !== null);
  if (!pts.length) return { maxObservedReturnPct: null, maxObservedAt: null, minObservedReturnPct: null, minObservedAt: null, observedPoints: 0 };
  const max = pts.reduce((m, c) => (c.decisionReturnPct! > m.decisionReturnPct! ? c : m));
  const min = pts.reduce((m, c) => (c.decisionReturnPct! < m.decisionReturnPct! ? c : m));
  return { maxObservedReturnPct: max.decisionReturnPct, maxObservedAt: max.observedAt, minObservedReturnPct: min.decisionReturnPct, minObservedAt: min.observedAt, observedPoints: pts.length };
}
