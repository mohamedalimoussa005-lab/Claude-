import type { NormalizedPair } from "../../src/domain/normalize.ts";
import type { DecisionMarket, Timeline } from "../../src/outcomes/tracker.ts";

/** Step-2-only chronology: every step at `t0` + offsets (ms); decision market fetched `marketDelayMs` after the decision. */
export function step2Timeline(t0: number, decisionDelayMs = 0, marketDelayMs = 0): Timeline {
  const d = t0 + decisionDelayMs;
  return { captureStartedAt: t0, marketObservedAt: t0, step2CompletedAt: t0, step3StartedAt: null, step3CompletedAt: null, step4StartedAt: null, step4CompletedAt: null, assessmentCompletedAt: d, decisionAvailableAt: d, snapshotFinalizedAt: d + marketDelayMs };
}

/** Decision market OK at `observedAt` with the pair's own price unless another price is given. */
export function okDecisionMarket(p: NormalizedPair, observedAt: number, priceUsd: number | null = p.priceUsd): DecisionMarket {
  return { status: "OK", observedAt, provider: "dexscreener", priceUsd, liquidityUsd: p.liquidityUsd, marketCap: p.marketCap, fdv: p.fdv, note: null };
}
