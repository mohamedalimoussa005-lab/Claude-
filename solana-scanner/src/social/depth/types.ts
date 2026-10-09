/**
 * Depth engine — shared types.
 *
 * A Venue is an immutable model of one pool. `buy` / `sell` simulate an exact-input swap of
 * the user's gross amount (transfer fees included) and return the next Venue, so consecutive
 * swaps (round trips) see the state the previous one left.
 *
 * A simulation is a deterministic calculation on a snapshot. It is not a quote, not a promise
 * of execution, and ignores anything that can change before a transaction lands.
 */

import type { Ratio } from "./math.ts";

export type VenueKind = "clmm" | "cpmm" | "pumpswap";

/**
 * How the swap formula was verified.
 *   program_source  the program is open source and the formula was read in its code.
 *   official_sdk    the program source is not public; the formula is the vendor's official SDK.
 */
export type FormulaAssurance = "program_source" | "official_sdk";

export interface VenueInfo {
  kind: VenueKind;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  formulaAssurance: FormulaAssurance;
  /** Token-2022 transfer tax in force on each side, basis points (0 when none). */
  transferTaxBps: { base: number; quote: number };
  /** Human-readable fee summary (rates read from the pool / config accounts). */
  fees: string[];
  /** Features of the pool this engine does not simulate; non-empty makes every result an estimate. */
  unsupported: string[];
  /** False when the engine could not read all the liquidity data (e.g. tick arrays). */
  dataComplete: boolean;
  /** Things the simulation assumes. */
  assumptions: string[];
}

export type FailReason =
  | "liquidity_exhausted" // the pool has no more liquidity in that direction
  | "beyond_loaded_data" // the swap needs data that was not loaded (e.g. tick arrays)
  | "insufficient_real_reserves" // priced on effective reserves, but the real reserves cannot pay out
  | "amount_too_small"
  | "fees_exceed_amount"
  | "pool_depleted"
  | "unsupported";

export interface SwapFill {
  ok: true;
  /** Raw units the user sends (gross, any transfer fee included). */
  amountIn: bigint;
  /** Raw units the user receives (net of fees and of any transfer fee). */
  amountOut: bigint;
  /** Fees paid, raw units, labelled by the token they are paid in. */
  fees: Record<string, bigint>;
  next: Venue;
}

export interface SwapFailure {
  ok: false;
  reason: FailReason;
  detail: string;
}

export type SwapOutcome = SwapFill | SwapFailure;

export interface Venue {
  readonly info: VenueInfo;
  /** Current marginal price: raw quote units per raw base unit. */
  spot(): Ratio;
  /** Pay `quoteIn` raw quote units (gross) to buy the base token. */
  buy(quoteIn: bigint): SwapOutcome;
  /** Sell `baseIn` raw base units (gross) for the quote token. */
  sell(baseIn: bigint): SwapOutcome;
}
