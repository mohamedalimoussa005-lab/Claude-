/**
 * Coordination analysis — shared types and the single configuration object.
 *
 * Everything here is pure: no network, clock or environment access. The analysis works on transactions that were
 * already read (fixtures in tests, a collector script in production) and says explicitly how much of the history it
 * actually saw (`Coverage`). It never concludes to fraud or to common control.
 */

import { USDC_MINT, USDT_MINT, WSOL_MINT } from "./entities.ts";

/** Every tunable number lives here. Callers may override any field with `withConfig`. */
export interface CoordinationConfig {
  funding: {
    /** How many hops of "who funded the funder" are followed (1 = direct funder only). */
    maxHops: number;
    /** At most this many cohort wallets are traced per token (the rest are reported as not traced). */
    maxWallets: number;
    /** An inbound SOL transfer below this many lamports is not considered a funding. */
    minFundingLamports: bigint;
    /** Two fundings are "similar" when their amounts differ by at most this fraction. */
    similarAmountTolerance: number;
    /** Fundings within this many seconds of each other count as one burst. */
    burstSeconds: number;
    /** A funder seen funding at least this many unrelated wallets (sampled) is treated as a probable service. */
    serviceFanout: number;
    /** A funder whose sampled signature list was capped at this many entries is treated as a probable service. */
    serviceActivityCap: number;
  };
  launch: {
    /** Cohort = the first N distinct buyers of the token. */
    cohortSize: number;
    /** Launch window in slots from the first observed trade. */
    windowSlots: number;
    /** Buys at most this many slots apart count as synchronous. */
    syncSlots: number;
    /** Minimum quote amount (raw units of the quote mint, keyed by mint) for a buy to count as a cohort buy. */
    minBuyQuote: Record<string, bigint>;
    /** Minimum for a quote mint not listed above (0 = any positive amount). */
    minBuyQuoteDefault: bigint;
    /** Monte-Carlo draws for the synchrony p-value (deterministic seed from `wash.seed`). */
    simulations: number;
    /** Width (in slots) of the bins that give the arrival-rate baseline; buys are spread uniformly inside a bin so a one-slot spike cannot hide itself. */
    baselineBinSlots: number;
  };
  cluster: {
    /** Quote amounts within this fraction count as similar. */
    amountTolerance: number;
    /** Sells within this many slots of each other count as synchronous exits. */
    exitSyncSlots: number;
    /** A group needs at least this many wallets to be reported. */
    minGroupSize: number;
    /** Independent signal families needed for a multi-signal group. */
    minFamiliesForMulti: number;
    /** Families needed (at least one outside funding/timing) before a coordination hypothesis is written. */
    minFamiliesForHypothesis: number;
    /** Permutations for the null model of multi-family pairs (families shuffled independently). */
    permutations: number;
  };
  wash: {
    /** A buy and a later sell by the same wallet within this many seconds form a round trip. */
    roundTripSeconds: number;
    /** A round trip matches only if the sold base amount is at least this fraction of the bought one. */
    matchMinFraction: number;
    /** Trade sizes within this fraction of the modal size count as repeated sizes. */
    sizeTolerance: number;
    /** Minimum trades of one wallet before its regularity is judged. */
    minTradesForRegularity: number;
    /** A wallet is "metronomic" when at least this share of its trades repeat one size... */
    repeatShareFlag: number;
    /** ...and the coefficient of variation of its inter-trade intervals is below this. */
    intervalCvFlag: number;
    /** Round trips above this share of gross volume are flagged (a measured level, not a validated threshold). */
    roundTripShareFlag: number;
    /** Label-permutation null model: number of draws and PRNG seed (deterministic). */
    permutations: number;
    seed: number;
  };
  /** p-values below this are reported as statistically unusual (still only an indication). */
  alpha: number;
}

export const DEFAULT_CONFIG: CoordinationConfig = {
  funding: { maxHops: 2, maxWallets: 50, minFundingLamports: 10_000_000n, similarAmountTolerance: 0.05, burstSeconds: 600, serviceFanout: 100, serviceActivityCap: 1000 },
  launch: { cohortSize: 50, windowSlots: 150, syncSlots: 1, minBuyQuote: { [WSOL_MINT]: 1_000_000n, [USDC_MINT]: 10_000n, [USDT_MINT]: 10_000n }, minBuyQuoteDefault: 0n, simulations: 500, baselineBinSlots: 10 },
  cluster: { amountTolerance: 0.05, exitSyncSlots: 2, minGroupSize: 3, minFamiliesForMulti: 2, minFamiliesForHypothesis: 3, permutations: 200 },
  wash: { roundTripSeconds: 600, matchMinFraction: 0.8, sizeTolerance: 0.01, minTradesForRegularity: 4, repeatShareFlag: 0.8, intervalCvFlag: 0.25, roundTripShareFlag: 0.3, permutations: 200, seed: 20260101 },
  alpha: 0.01,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends bigint | number ? T[K] : DeepPartial<T[K]> };

export function withConfig(over: DeepPartial<CoordinationConfig> = {}): CoordinationConfig {
  const c: CoordinationConfig = structuredClone(DEFAULT_CONFIG);
  for (const k of Object.keys(over) as (keyof CoordinationConfig)[]) {
    const v = over[k];
    if (v === undefined) continue;
    if (typeof v === "number") (c as unknown as Record<string, unknown>)[k] = v;
    else Object.assign(c[k] as object, v);
  }
  validateConfig(c);
  return c;
}

export function validateConfig(c: CoordinationConfig): void {
  const pos = (n: number, name: string, int = true) => {
    if (!Number.isFinite(n) || n <= 0 || (int && !Number.isInteger(n))) throw new RangeError(`config ${name} must be a positive${int ? " integer" : " number"}`);
  };
  pos(c.funding.maxHops, "funding.maxHops");
  pos(c.funding.maxWallets, "funding.maxWallets");
  pos(c.funding.burstSeconds, "funding.burstSeconds");
  pos(c.launch.cohortSize, "launch.cohortSize");
  pos(c.launch.windowSlots, "launch.windowSlots");
  pos(c.wash.permutations, "wash.permutations");
  pos(c.launch.simulations, "launch.simulations");
  pos(c.launch.baselineBinSlots, "launch.baselineBinSlots");
  pos(c.cluster.permutations, "cluster.permutations");
  pos(c.cluster.minGroupSize, "cluster.minGroupSize");
  pos(c.cluster.minFamiliesForMulti, "cluster.minFamiliesForMulti");
  pos(c.cluster.minFamiliesForHypothesis, "cluster.minFamiliesForHypothesis");
  for (const [v, n] of [[c.funding.similarAmountTolerance, "funding.similarAmountTolerance"], [c.cluster.amountTolerance, "cluster.amountTolerance"], [c.wash.sizeTolerance, "wash.sizeTolerance"], [c.wash.matchMinFraction, "wash.matchMinFraction"], [c.wash.repeatShareFlag, "wash.repeatShareFlag"], [c.wash.roundTripShareFlag, "wash.roundTripShareFlag"], [c.alpha, "alpha"]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`config ${n} must be within [0,1]`);
  }
  if (c.cluster.minFamiliesForHypothesis < c.cluster.minFamiliesForMulti) throw new RangeError("config minFamiliesForHypothesis must be >= minFamiliesForMulti");
}

/** A SOL transfer read from a system-program instruction (top level or inner). */
export interface SolTransfer {
  signature: string;
  slot: number;
  blockTime: number | null;
  from: string;
  to: string;
  lamports: bigint;
}

export interface TokenDelta {
  owner: string;
  mint: string;
  /** post − pre, in raw units, summed over all the owner's token accounts for this mint. */
  delta: bigint;
}

/** A transaction reduced to what the analysis needs. */
export interface NormalizedTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  feePayer: string;
  signers: string[];
  fee: bigint;
  /** Distinct program ids invoked (top level and inner). */
  programs: string[];
  /** Lamport change per account (post − pre), fee not removed. */
  solDeltas: Record<string, bigint>;
  tokenDeltas: TokenDelta[];
  solTransfers: SolTransfer[];
  /** Lamports moved by account creation (rent) out of each funder, to be excluded from "amount spent". */
  rentByPayer: Record<string, bigint>;
}

export type Side = "buy" | "sell";

/** A buy or sell of the analysed token by one wallet in one transaction. */
export interface SwapEvent {
  signature: string;
  slot: number;
  blockTime: number | null;
  trader: string;
  side: Side;
  /** Raw base-token units moved (always positive). */
  baseAmount: bigint;
  /** Mint of the quote leg (native SOL and wrapped SOL are both the wSOL mint). */
  quoteMint: string;
  /** Approximate quote amount moved by the trader, raw units of `quoteMint` (for SOL: net of fee, rent and tips). Always >= 0. */
  quoteAmount: bigint;
  /** Programs that make this a swap (DEX programs invoked). */
  dexPrograms: string[];
}

/** How much of the history was actually read. Every result carries one. */
export interface Coverage {
  /** True only when the signature list reached the oldest transaction of the address. */
  signaturesComplete: boolean;
  signaturesRead: number;
  transactionsRead: number;
  /** Transactions listed but not obtained (RPC error, pruned). */
  transactionsMissing: number;
  oldestSlot: number | null;
  newestSlot: number | null;
  notes: string[];
}

export type EntityKind = "exchange" | "bridge" | "router" | "bot" | "program" | "protocol" | "service_probable" | "creator";

export interface KnownEntity {
  kind: EntityKind;
  label: string;
}
