/**
 * Launch buyers: who bought first, how concentrated, how synchronous.
 *
 * Observed (from transactions): who bought in which slot and for how much.
 * Statistical (computed): concentration indices and a same-slot collision count compared with a baseline.
 * Nothing here says why the buyers bought at the same time.
 *
 * Ordering inside one slot is not available from RPC data: ranks inside a slot are ordered by signature only to be
 * deterministic, and the report says so.
 */

import type { Coverage, CoordinationConfig, KnownEntity, SwapEvent } from "./model.ts";
import { DEFAULT_CONFIG } from "./model.ts";
import { gini, hhi, prng } from "./stats.ts";

export interface CohortMember {
  wallet: string;
  /** 1-based rank among first buyers (ties inside a slot broken by signature, not by execution order). */
  rank: number;
  firstBuySlot: number;
  firstBuySignature: string;
  firstBuyQuote: bigint;
  buys: number;
  boughtBase: bigint;
  boughtQuote: bigint;
  /** Base sold by this wallet inside the launch window. */
  soldBaseInWindow: bigint;
  sells: number;
}

export interface LaunchReport {
  mint: string;
  /** False when the signature history did not reach the oldest transaction: the "launch" is then only the earliest data read. */
  launchObserved: boolean;
  firstSlot: number | null;
  windowEndSlot: number | null;
  swapsInWindow: number;
  buysInWindow: number;
  cohort: CohortMember[];
  /** Buys by the creator, kept apart (never counted as independent buyers). */
  creatorBuys: { signature: string; slot: number; baseAmount: bigint; quoteAmount: bigint }[];
  /** Wallets left out of the cohort because they are programs, routers, services or the creator. */
  excluded: { wallet: string; reason: string }[];
  buyersFirstSlot: number;
  buyersWithin5Slots: number;
  /** Share of the supply the cohort still holds at the end of the window (bought minus sold, per wallet, floored at 0), if the supply is known. */
  cohortSupplyShare: number | null;
  /** Gross base bought by the cohort / supply: can exceed 1 when wallets buy again after selling. */
  cohortGrossBuyShare: number | null;
  /** Share of the window's buyer base amount held by the 5 largest cohort buyers. */
  top5BuyShare: number | null;
  hhiQuote: number | null;
  giniQuote: number | null;
  sync: SyncStat;
  coverage: Coverage;
  notes: string[];
}

export interface SyncStat {
  cohortSize: number;
  /** Pairs of cohort wallets whose first buys are at most `syncSlots` apart. */
  observedPairs: number;
  /** Mean close pairs over the baseline draws (buy slots drawn from the window's own distribution of buys). */
  expectedPairs: number;
  /** Monte-Carlo p-value: share of baseline draws with at least as many close pairs (add-one smoothed). */
  pValue: number | null;
  unusual: boolean;
}

export interface LaunchArgs {
  mint: string;
  swaps: readonly SwapEvent[];
  creator: string | null;
  entities: ReadonlyMap<string, KnownEntity>;
  supplyRaw: bigint | null;
  coverage: Coverage;
  cfg?: CoordinationConfig;
}

const bySlotThenSig = (a: { slot: number; signature: string }, b: { slot: number; signature: string }) => a.slot - b.slot || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);

export function analyzeLaunch(args: LaunchArgs): LaunchReport {
  const cfg = args.cfg ?? DEFAULT_CONFIG;
  const notes: string[] = ["ordre à l'intérieur d'un même slot inconnu (rang départagé par signature)"];
  const all = [...args.swaps].sort(bySlotThenSig);
  const launchObserved = args.coverage.signaturesComplete;
  if (!launchObserved) notes.push("historique incomplet: les premières transactions du token n'ont pas été atteintes, le lancement n'est pas observé");
  if (args.coverage.transactionsMissing > 0) notes.push(`${args.coverage.transactionsMissing} transaction(s) listée(s) mais non lue(s)`);
  if (all.length === 0) {
    return { mint: args.mint, launchObserved, firstSlot: null, windowEndSlot: null, swapsInWindow: 0, buysInWindow: 0, cohort: [], creatorBuys: [], excluded: [], buyersFirstSlot: 0, buyersWithin5Slots: 0, cohortSupplyShare: null, cohortGrossBuyShare: null, top5BuyShare: null, hhiQuote: null, giniQuote: null, sync: { cohortSize: 0, observedPairs: 0, expectedPairs: 0, pValue: null, unusual: false }, coverage: args.coverage, notes: [...notes, "aucun swap lu"] };
  }
  const firstSlot = all[0]!.slot;
  const windowEnd = firstSlot + cfg.launch.windowSlots;
  const win = all.filter((s) => s.slot <= windowEnd);
  const buys = win.filter((s) => s.side === "buy");

  const excluded = new Map<string, string>();
  const creatorBuys: LaunchReport["creatorBuys"] = [];
  const members = new Map<string, CohortMember>();
  let rank = 0;
  for (const s of win) {
    const ent = args.entities.get(s.trader);
    if (ent && ent.kind !== "creator") {
      excluded.set(s.trader, `${ent.kind}: ${ent.label}`);
      continue;
    }
    if (args.creator !== null && s.trader === args.creator) {
      excluded.set(s.trader, "creator (compté à part)");
      if (s.side === "buy") creatorBuys.push({ signature: s.signature, slot: s.slot, baseAmount: s.baseAmount, quoteAmount: s.quoteAmount });
      continue;
    }
    let m = members.get(s.trader);
    if (s.side === "buy") {
      if (s.quoteAmount < (cfg.launch.minBuyQuote[s.quoteMint] ?? cfg.launch.minBuyQuoteDefault)) continue;
      if (!m) {
        if (members.size >= cfg.launch.cohortSize) continue;
        m = { wallet: s.trader, rank: ++rank, firstBuySlot: s.slot, firstBuySignature: s.signature, firstBuyQuote: s.quoteAmount, buys: 0, boughtBase: 0n, boughtQuote: 0n, soldBaseInWindow: 0n, sells: 0 };
        members.set(s.trader, m);
      }
      m.buys++;
      m.boughtBase += s.baseAmount;
      m.boughtQuote += s.quoteAmount;
    } else if (m) {
      m.sells++;
      m.soldBaseInWindow += s.baseAmount;
    }
  }
  const cohort = [...members.values()];
  if (cohort.length === cfg.launch.cohortSize) notes.push(`cohorte plafonnée à ${cfg.launch.cohortSize} acheteurs (réglable)`);

  const slotsOf = cohort.map((m) => m.firstBuySlot);
  const buyersFirstSlot = slotsOf.filter((s) => s === firstSlot).length;
  const buyersWithin5Slots = slotsOf.filter((s) => s <= firstSlot + 5).length;
  const quote = cohort.map((m) => Number(m.boughtQuote));
  const top5 = [...cohort].sort((a, b) => (b.boughtBase > a.boughtBase ? 1 : b.boughtBase < a.boughtBase ? -1 : 0)).slice(0, 5);
  const totalBase = cohort.reduce((a, m) => a + m.boughtBase, 0n);
  const top5Base = top5.reduce((a, m) => a + m.boughtBase, 0n);
  const netBase = cohort.reduce((a, m) => a + (m.boughtBase > m.soldBaseInWindow ? m.boughtBase - m.soldBaseInWindow : 0n), 0n);

  return {
    mint: args.mint,
    launchObserved,
    firstSlot,
    windowEndSlot: windowEnd,
    swapsInWindow: win.length,
    buysInWindow: buys.length,
    cohort,
    creatorBuys,
    excluded: [...excluded].map(([wallet, reason]) => ({ wallet, reason })),
    buyersFirstSlot,
    buyersWithin5Slots,
    cohortSupplyShare: args.supplyRaw && args.supplyRaw > 0n ? Number((netBase * 1_000_000n) / args.supplyRaw) / 1_000_000 : null,
    cohortGrossBuyShare: args.supplyRaw && args.supplyRaw > 0n ? Number((totalBase * 1_000_000n) / args.supplyRaw) / 1_000_000 : null,
    top5BuyShare: totalBase > 0n ? Number((top5Base * 1_000_000n) / totalBase) / 1_000_000 : null,
    hhiQuote: hhi(quote),
    giniQuote: gini(quote),
    sync: syncStat(cohort, buys, cfg),
    coverage: args.coverage,
    notes,
  };
}

/**
 * Close-in-time (±syncSlots) first buys among cohort wallets vs a Monte-Carlo baseline: the same number of buyers
 * is drawn `simulations` times with a fixed seed. The baseline is the window's own arrival rate at a coarse scale:
 * a buy is drawn at random, then placed uniformly inside its `baselineBinSlots`-slot bin — so a hot launch is
 * compared with itself, but a spike confined to one slot cannot hide inside its own baseline. Pairs are counted
 * exactly in each draw, so the dependence between pairs (one crowded slot makes many pairs) is respected. A slot
 * weighs at most the 90th percentile of occupied slots in the baseline.
 */
export function syncStat(cohort: readonly CohortMember[], windowBuys: readonly SwapEvent[], cfg: CoordinationConfig): SyncStat {
  const n = cohort.length;
  const d = cfg.launch.syncSlots;
  const closePairs = (slots: number[]): number => {
    const s = [...slots].sort((a, b) => a - b);
    let c = 0;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length && s[j]! - s[i]! <= d; j++) c++;
    return c;
  };
  const observed = closePairs(cohort.map((m) => m.firstBuySlot));
  if (n < 2 || windowBuys.length === 0) return { cohortSize: n, observedPairs: observed, expectedPairs: 0, pValue: null, unusual: false };
  // robust baseline: a slot cannot weigh more than the 90th percentile of occupied slots (so one crowded slot —
  // possibly the very thing being tested — does not dominate its own baseline)
  const perSlot = new Map<number, number>();
  for (const b of windowBuys) perSlot.set(b.slot, (perSlot.get(b.slot) ?? 0) + 1);
  const counts = [...perSlot.values()].sort((a, b) => a - b);
  const cap = Math.max(1, counts[Math.min(counts.length - 1, Math.floor(0.9 * counts.length))]!);
  const base: number[] = [];
  for (const [slot, c] of perSlot) for (let k = 0; k < Math.min(c, cap); k++) base.push(slot);
  const bin = cfg.launch.baselineBinSlots;
  const rnd = prng(cfg.wash.seed + 17);
  let sum = 0;
  let ge = 0;
  for (let r = 0; r < cfg.launch.simulations; r++) {
    const draw = Array.from({ length: n }, () => {
      const slot = base[Math.floor(rnd() * base.length)]!;
      const lo = Math.floor(slot / bin) * bin;
      return lo + Math.floor(rnd() * bin);
    });
    const c = closePairs(draw);
    sum += c;
    if (c >= observed) ge++;
  }
  const p = (ge + 1) / (cfg.launch.simulations + 1);
  return { cohortSize: n, observedPairs: observed, expectedPairs: sum / cfg.launch.simulations, pValue: p, unusual: observed > 0 && p < cfg.alpha };
}
