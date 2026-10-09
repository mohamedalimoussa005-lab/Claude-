/**
 * Raydium CLMM (concentrated liquidity) exact-input swap simulation.
 *
 * Formulas follow raydium-io/raydium-clmm (programs/amm/src), read on 2026-10-09:
 *   libraries/tick_math.rs        get_sqrt_price_at_tick / get_tick_at_sqrt_price
 *   libraries/sqrt_price_math.rs  get_next_sqrt_price_from_input
 *   libraries/liquidity_math.rs   get_delta_amounts_for_swap, add_delta
 *   libraries/swap_math.rs        compute_swap (fee on input, or on output when pool.fee_on says so)
 *   instructions/swap.rs          the tick-walking loop
 * All sqrt prices are Q64.64 unsigned integers; every rounding direction below is the program's.
 *
 * Not simulated (the pool is then marked unsupported and every result is an estimate):
 * dynamic fees, limit orders on ticks.
 */

import { divCeil, MathError, mulDivCeil, mulDivFloor, U128_MAX, U64_MAX } from "./math.ts";
import type { Ratio } from "./math.ts";
import { MAX_SQRT_PRICE_X64, MAX_TICK, MIN_SQRT_PRICE_X64, MIN_TICK, TICK_RATIO_CONSTANTS } from "./tickConstants.ts";
import { afterTransferFee, transferFee } from "./token2022.ts";
import type { TransferFee } from "./token2022.ts";
import type { SwapOutcome, Venue, VenueInfo } from "./types.ts";

export const FEE_RATE_DENOMINATOR = 1_000_000n;
const Q64_SHIFT = 64n;

// ───────────────────────── tick math ─────────────────────────

/** sqrt(1.0001^tick) in Q64.64, exactly as the program computes it (bitwise product of constants). */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new MathError("overflow", `tick out of range: ${tick}`);
  const abs = BigInt(Math.abs(tick));
  let ratio = abs & 1n ? TICK_RATIO_CONSTANTS[0]! : 1n << Q64_SHIFT;
  for (let i = 1; i < TICK_RATIO_CONSTANTS.length; i++) {
    if (abs & (1n << BigInt(i))) ratio = (ratio * TICK_RATIO_CONSTANTS[i]!) >> Q64_SHIFT;
  }
  if (tick > 0) ratio = U128_MAX / ratio;
  return ratio;
}

/** The tick whose range contains `sqrtPriceX64` (largest tick with sqrt price ≤ it). */
export function getTickAtSqrtPrice(sqrtPriceX64: bigint): number {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 >= MAX_SQRT_PRICE_X64) throw new MathError("overflow", "sqrt price out of range");
  const msb = BigInt(sqrtPriceX64.toString(2).length - 1);
  const log2IntegerX32 = (msb - 64n) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let precision = 0;
  let log2FractionX64 = 0n;
  let r = msb >= 64n ? sqrtPriceX64 >> (msb - 63n) : sqrtPriceX64 << (63n - msb);
  while (bit > 0n && precision < 16) {
    r *= r;
    const moreThanTwo = r >> 127n;
    r >>= 63n + moreThanTwo;
    log2FractionX64 += bit * moreThanTwo;
    bit >>= 1n;
    precision++;
  }
  const log2X32 = log2IntegerX32 + (log2FractionX64 >> 32n);
  const logSqrt10001X64 = log2X32 * 59543866431248n;
  const tickLow = Number((logSqrt10001X64 - 184467440737095516n) >> 64n);
  const tickHigh = Number((logSqrt10001X64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return getSqrtPriceAtTick(tickHigh) <= sqrtPriceX64 ? tickHigh : tickLow;
}

// ───────────────────────── swap math ─────────────────────────

class MaxTokenOverflow extends Error {}

/** Amounts to move the price between two sqrt prices: input rounded up, output rounded down. */
function deltaAmountsForSwap(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, zeroForOne: boolean): { amountIn: bigint; amountOut: bigint } {
  let a = sqrtA;
  let b = sqrtB;
  if (a > b) [a, b] = [b, a];
  if (a === 0n) throw new MathError("division_by_zero", "zero sqrt price");
  const amount1X64 = liquidity * (b - a);
  const product = a * b;
  let amountIn: bigint;
  let amountOut: bigint;
  if (zeroForOne) {
    amountIn = divCeil(amount1X64 << Q64_SHIFT, product);
    amountOut = amount1X64 >> Q64_SHIFT;
  } else {
    amountIn = (amount1X64 + U64_MAX) >> Q64_SHIFT;
    amountOut = (amount1X64 << Q64_SHIFT) / product;
  }
  if (amountIn > U64_MAX || amountOut > U64_MAX) throw new MaxTokenOverflow();
  return { amountIn, amountOut };
}

/** New sqrt price after adding `amountIn` of the input token (price moves against the trader's token). */
function nextSqrtPriceFromInput(sqrt: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrt < MIN_SQRT_PRICE_X64 || sqrt >= MAX_SQRT_PRICE_X64) throw new MathError("overflow", "sqrt price out of range");
  if (liquidity <= 0n) throw new MathError("division_by_zero", "zero liquidity");
  if (amountIn === 0n) return sqrt;
  if (zeroForOne) {
    const numerator1 = liquidity << Q64_SHIFT;
    return mulDivCeil(numerator1, sqrt, numerator1 + amountIn * sqrt);
  }
  const next = sqrt + (amountIn << Q64_SHIFT) / liquidity;
  if (next > U128_MAX) throw new MathError("overflow", "sqrt price overflow");
  return next;
}

export interface SwapStep {
  sqrtNext: bigint;
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
}

/** compute_swap for an exact-input step. */
export function computeSwapStepExactIn(sqrtCur: bigint, sqrtTarget: bigint, liquidity: bigint, remaining: bigint, feeRate: bigint, zeroForOne: boolean, feeOnInput: boolean): SwapStep {
  const amountForPrice = feeOnInput ? mulDivFloor(remaining, FEE_RATE_DENOMINATOR - feeRate, FEE_RATE_DENOMINATOR) : remaining;
  let reach: { amountIn: bigint; amountOut: bigint } | null = null;
  try {
    const atTarget = deltaAmountsForSwap(sqrtTarget, sqrtCur, liquidity, zeroForOne);
    if (amountForPrice >= atTarget.amountIn) reach = atTarget;
  } catch (e) {
    if (!(e instanceof MaxTokenOverflow)) throw e; // target unreachable at u64 precision → not reached
  }
  let sqrtNext: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  if (reach) {
    sqrtNext = sqrtTarget;
    amountIn = reach.amountIn;
    amountOut = reach.amountOut;
  } else {
    sqrtNext = nextSqrtPriceFromInput(sqrtCur, liquidity, amountForPrice, zeroForOne);
    ({ amountIn, amountOut } = deltaAmountsForSwap(sqrtNext, sqrtCur, liquidity, zeroForOne));
  }
  if (zeroForOne ? sqrtNext < sqrtTarget : sqrtNext > sqrtTarget) throw new MathError("overflow", "step overshoots its target");
  let fee: bigint;
  if (feeOnInput) {
    fee = sqrtNext !== sqrtTarget ? remaining - amountIn : mulDivCeil(amountIn, feeRate, FEE_RATE_DENOMINATOR - feeRate);
  } else {
    fee = mulDivCeil(amountOut, feeRate, FEE_RATE_DENOMINATOR);
    amountOut -= fee;
    // Partial step: the whole remaining input is charged (the sub-unit excess goes to the pool).
    if (sqrtNext !== sqrtTarget) amountIn = remaining;
  }
  return { sqrtNext, amountIn, amountOut, fee };
}

/** pool.fee_on: 0 = fee on the input token, 1 = always token0, 2 = always token1. */
export function isFeeOnInput(feeOn: number, zeroForOne: boolean): boolean {
  if (feeOn === 1) return zeroForOne;
  if (feeOn === 2) return !zeroForOne;
  return true;
}

// ───────────────────────── the venue ─────────────────────────

export interface ClmmTick {
  tick: number;
  liquidityNet: bigint;
}

export interface ClmmVenueParams {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseIsToken0: boolean;
  sqrtPriceX64: bigint;
  liquidity: bigint;
  tickCurrent: number;
  /** Trade fee rate, parts per million (AmmConfig.trade_fee_rate). */
  feeRate: number;
  feeOn: number;
  /** Initialized ticks, ascending. */
  ticks: ClmmTick[];
  /** True when every tick array of the pool was read (otherwise liquidity beyond the loaded ticks is unknown). */
  ticksComplete: boolean;
  unsupported: string[];
  transferFee: { base: TransferFee | null; quote: TransferFee | null };
}

function describe(p: ClmmVenueParams): VenueInfo {
  const feePct = (Number(p.feeRate) / 1e4).toFixed(4).replace(/\.?0+$/, "");
  return {
    kind: "clmm",
    poolAddress: p.poolAddress,
    baseMint: p.baseMint,
    quoteMint: p.quoteMint,
    baseDecimals: p.baseDecimals,
    quoteDecimals: p.quoteDecimals,
    transferTaxBps: { base: p.transferFee.base?.bps ?? 0, quote: p.transferFee.quote?.bps ?? 0 },
    formulaAssurance: "program_source",
    fees: [`trade fee ${feePct} % (${p.feeRate}/1 000 000) charged ${p.feeOn === 0 ? "on the input token" : p.feeOn === 1 ? "in token0" : "in token1"}`],
    unsupported: p.unsupported,
    dataComplete: p.ticksComplete,
    assumptions: ["liquidity changes only at the loaded initialized ticks", "pool state frozen at the snapshot slot", "no concurrent trades, no slippage limit, no priority fee or tip"],
  };
}

export function createClmmVenue(p: ClmmVenueParams): Venue {
  const ticks = [...p.ticks].sort((a, b) => a.tick - b.tick);
  const info = describe(p);
  const feeRate = BigInt(p.feeRate);

  const spot = (): Ratio => {
    const sq2 = p.sqrtPriceX64 * p.sqrtPriceX64;
    const q128 = 1n << 128n;
    return p.baseIsToken0 ? { num: sq2, den: q128 } : { num: q128, den: sq2 };
  };

  const swap = (amountIn: bigint, zeroForOne: boolean): { ok: true; used: bigint; out: bigint; fee: bigint; next: ClmmVenueParams } | { ok: false; reason: "liquidity_exhausted" | "beyond_loaded_data"; detail: string } => {
    const feeOnInput = isFeeOnInput(p.feeOn, zeroForOne);
    const limit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
    let sqrt = p.sqrtPriceX64;
    let liquidity = p.liquidity;
    let tick = p.tickCurrent;
    let remaining = amountIn;
    let out = 0n;
    let fees = 0n;
    for (let guard = 0; remaining > 0n && sqrt !== limit; guard++) {
      if (guard > ticks.length + 8) throw new MathError("overflow", "swap loop did not converge");
      // next initialized tick in the direction of the trade
      let next: ClmmTick | undefined;
      if (zeroForOne) {
        for (let i = ticks.length - 1; i >= 0; i--) if (ticks[i]!.tick <= tick) { next = ticks[i]; break; }
      } else {
        next = ticks.find((t) => t.tick > tick);
      }
      if (!next) {
        const detail = `no initialized tick ahead after consuming ${amountIn - remaining} of ${amountIn}`;
        return p.ticksComplete ? { ok: false, reason: "liquidity_exhausted", detail } : { ok: false, reason: "beyond_loaded_data", detail };
      }
      const tickNext = Math.min(MAX_TICK, Math.max(MIN_TICK, next.tick));
      const sqrtNextTick = getSqrtPriceAtTick(tickNext);
      const target = zeroForOne ? (sqrtNextTick < limit ? limit : sqrtNextTick) : sqrtNextTick > limit ? limit : sqrtNextTick;
      let stepSqrt = sqrt;
      if (sqrt !== target) {
        const step = computeSwapStepExactIn(sqrt, target, liquidity, remaining, feeRate, zeroForOne, feeOnInput);
        remaining -= feeOnInput ? step.amountIn + step.fee : step.amountIn;
        out += step.amountOut;
        fees += step.fee;
        stepSqrt = step.sqrtNext;
      }
      if (stepSqrt === sqrtNextTick) {
        // the tick is crossed: active liquidity changes (sign flips when the price falls)
        let net = next.liquidityNet;
        if (zeroForOne) net = -net;
        liquidity += net;
        if (liquidity < 0n) throw new MathError("negative", "liquidity underflow at a crossed tick");
        tick = zeroForOne ? tickNext - 1 : tickNext;
      } else if (stepSqrt !== sqrt) {
        tick = getTickAtSqrtPrice(stepSqrt);
      }
      sqrt = stepSqrt;
      if (stepSqrt === limit && remaining > 0n) break;
    }
    if (remaining > 0n) return { ok: false, reason: "liquidity_exhausted", detail: `price limit reached with ${remaining} of ${amountIn} unconsumed` };
    return { ok: true, used: amountIn, out, fee: fees, next: { ...p, sqrtPriceX64: sqrt, liquidity, tickCurrent: tick } };
  };

  const run = (userIn: bigint, zeroForOne: boolean, tfIn: TransferFee | null, tfOut: TransferFee | null, feeToken: "quote" | "base"): SwapOutcome => {
    if (userIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "amount must be positive" };
    if (userIn > U64_MAX) return { ok: false, reason: "unsupported", detail: "amount exceeds the u64 range of token amounts" };
    const poolIn = userIn - transferFee(userIn, tfIn);
    if (poolIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "transfer fee consumes the whole amount" };
    const r = swap(poolIn, zeroForOne);
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
    const userOut = afterTransferFee(r.out, tfOut);
    if (r.out <= 0n || userOut <= 0n) return { ok: false, reason: "amount_too_small", detail: "output rounds to zero" };
    return { ok: true, amountIn: userIn, amountOut: userOut, fees: { [`trade_fee_${feeToken}`]: r.fee, transfer_fee_in: transferFee(userIn, tfIn), transfer_fee_out: r.out - userOut }, next: createClmmVenue(r.next) };
  };

  return {
    info,
    spot,
    // base = token0: buying base means paying token1 → one_for_zero (price rises). base = token1: the opposite.
    buy: (quoteIn) => run(quoteIn, !p.baseIsToken0, p.transferFee.quote, p.transferFee.base, p.baseIsToken0 ? "quote" : "base"),
    sell: (baseIn) => run(baseIn, p.baseIsToken0, p.transferFee.base, p.transferFee.quote, p.baseIsToken0 ? "base" : "quote"),
  };
}
