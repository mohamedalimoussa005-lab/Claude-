/** Behavioural similarity between two cohort wallets, shared by the group extraction and the inference. */

import type { CoordinationConfig, SwapEvent } from "./model.ts";
import type { CohortMember } from "./launch.ts";
import { similar } from "./stats.ts";

/**
 * An amount that looks like a default pick: two significant digits ending in 0 or 5 (…0.5, 1, 1.5, 25, 100, 250…)
 * within 1 %. Works for any quote token because it only looks at the magnitude.
 */
export function isRoundAmount(amount: bigint): boolean {
  if (amount <= 0n) return false;
  const v = Number(amount);
  const scale = 10 ** Math.floor(Math.log10(v));
  const m = (v / scale) * 10; // 10..99.99
  const nearest = Math.round(m / 5) * 5;
  return Math.abs(m - nearest) <= 0.01 * m;
}

/** Slots of each cohort wallet's LARGE sells (at least half of what it bought), by wallet. */
export function largeExitSlots(cohort: readonly CohortMember[], swaps: readonly SwapEvent[]): Map<string, number[]> {
  const bought = new Map(cohort.map((m) => [m.wallet, m.boughtBase]));
  const out = new Map<string, number[]>();
  for (const s of swaps) {
    if (s.side !== "sell") continue;
    const b = bought.get(s.trader);
    if (b === undefined || b <= 0n || s.baseAmount * 2n < b) continue;
    (out.get(s.trader) ?? out.set(s.trader, []).get(s.trader)!).push(s.slot);
  }
  return out;
}

export type BehaviourFamily = "timing" | "amount" | "exit";

/** Which behavioural families link wallets a and b (no funding, no transfers). */
export function behaviourFamilies(a: CohortMember, b: CohortMember, exits: ReadonlyMap<string, number[]>, cfg: CoordinationConfig): BehaviourFamily[] {
  const out: BehaviourFamily[] = [];
  if (Math.abs(a.firstBuySlot - b.firstBuySlot) <= cfg.launch.syncSlots) out.push("timing");
  if (similar(a.firstBuyQuote, b.firstBuyQuote, cfg.cluster.amountTolerance) && !(isRoundAmount(a.firstBuyQuote) && isRoundAmount(b.firstBuyQuote))) out.push("amount");
  const ea = exits.get(a.wallet);
  const eb = exits.get(b.wallet);
  if (ea && eb && ea.some((x) => eb.some((y) => Math.abs(x - y) <= cfg.cluster.exitSyncSlots))) out.push("exit");
  return out;
}
