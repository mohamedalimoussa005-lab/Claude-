/**
 * Raydium CP-Swap (constant-product) exact-input swap simulation.
 *
 * Formulas follow raydium-io/raydium-cp-swap (programs/cp-swap/src), read on 2026-10-09:
 *   curve/fees.rs               trading_fee (ceil), protocol_fee / fund_fee (floor), creator_fee (ceil),
 *                               split_creator_fee (floor)
 *   curve/calculator.rs         swap_base_input (creator fee on input or on output)
 *   curve/constant_product.rs   out = floor(in × reserve_out / (reserve_in + in))
 *   instructions/swap_base_input.rs  Token-2022 transfer fee on the input and on the output
 *   states/pool.rs              reserves are the vault balances MINUS protocol, fund and creator fees
 *
 * Fees work differently from PumpSwap and CLMM: the creator fee may be taken on the input or the
 * output depending on pool.creator_fee_on, and the trade fee stays in the vault (the protocol and
 * fund shares are tracked and excluded from the reserves, the LP share compounds into them).
 */

import { mulDivCeil, mulDivFloor, U64_MAX } from "./math.ts";
import type { Ratio } from "./math.ts";
import { afterTransferFee, transferFee } from "./token2022.ts";
import type { TransferFee } from "./token2022.ts";
import type { SwapOutcome, Venue, VenueInfo } from "./types.ts";

const RATE_DEN = 1_000_000n;

export interface CpmmVenueParams {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseIsToken0: boolean;
  /** Net reserves: vault balance − protocol fees − fund fees − creator fees. */
  reserve0: bigint;
  reserve1: bigint;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  /** Already 0 when the pool has creator fees disabled. */
  creatorFeeRate: bigint;
  /** pool.creator_fee_on: 0 both tokens, 1 token0 only, 2 token1 only. */
  creatorFeeOn: number;
  /** Features of the pool this engine does not simulate (e.g. swaps disabled). */
  unsupported: string[];
  transferFee: { base: TransferFee | null; quote: TransferFee | null };
}

/** pool.is_creator_fee_on_input(direction). `zeroForOne` = the input token is token0. */
export function isCreatorFeeOnInput(creatorFeeOn: number, zeroForOne: boolean): boolean {
  if (creatorFeeOn === 0) return true;
  if (creatorFeeOn === 1) return zeroForOne;
  if (creatorFeeOn === 2) return !zeroForOne;
  throw new RangeError(`unknown creator_fee_on ${creatorFeeOn}`);
}

export interface CpmmSwapResult {
  newReserveIn: bigint;
  newReserveOut: bigint;
  /** What the pool pays out to the user (before the output transfer fee). */
  outputAmount: bigint;
  tradeFee: bigint;
  creatorFee: bigint;
  protocolFee: bigint;
  fundFee: bigint;
}

/** CurveCalculator::swap_base_input plus the vault accounting of update_fees. */
export function cpmmSwapBaseInput(inputAmount: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: bigint, creatorFeeRate: bigint, protocolFeeRate: bigint, fundFeeRate: bigint, creatorOnInput: boolean): CpmmSwapResult | null {
  let creatorFee = 0n;
  let tradeFee: bigint;
  let inputLessFees: bigint;
  if (creatorOnInput) {
    const totalFee = mulDivCeil(inputAmount, tradeFeeRate + creatorFeeRate, RATE_DEN);
    creatorFee = tradeFeeRate + creatorFeeRate === 0n ? 0n : mulDivFloor(totalFee, creatorFeeRate, tradeFeeRate + creatorFeeRate);
    tradeFee = totalFee - creatorFee;
    inputLessFees = inputAmount - totalFee;
  } else {
    tradeFee = mulDivCeil(inputAmount, tradeFeeRate, RATE_DEN);
    inputLessFees = inputAmount - tradeFee;
  }
  if (inputLessFees <= 0n) return null;
  const protocolFee = mulDivFloor(tradeFee, protocolFeeRate, RATE_DEN);
  const fundFee = mulDivFloor(tradeFee, fundFeeRate, RATE_DEN);
  const swapped = (inputLessFees * reserveOut) / (reserveIn + inputLessFees);
  let output = swapped;
  if (!creatorOnInput) {
    creatorFee = mulDivCeil(swapped, creatorFeeRate, RATE_DEN);
    output = swapped - creatorFee;
  }
  if (output <= 0n) return null;
  return {
    // The input vault grows by the full input; the tracked fee buckets leave the reserves, the LP share of the trade fee stays in.
    newReserveIn: reserveIn + inputAmount - protocolFee - fundFee - (creatorOnInput ? creatorFee : 0n),
    // The output vault pays `output`; the output-side creator fee is also bucketed out of the reserves.
    newReserveOut: reserveOut - swapped,
    outputAmount: output,
    tradeFee,
    creatorFee,
    protocolFee,
    fundFee,
  };
}

function describe(p: CpmmVenueParams): VenueInfo {
  const pct = (r: bigint) => `${(Number(r) / 1e4).toFixed(4).replace(/\.?0+$/, "")} %`;
  const tf = (x: TransferFee | null) => (x ? `${x.bps / 100} %` : "none");
  return {
    kind: "cpmm",
    poolAddress: p.poolAddress,
    baseMint: p.baseMint,
    quoteMint: p.quoteMint,
    baseDecimals: p.baseDecimals,
    quoteDecimals: p.quoteDecimals,
    transferTaxBps: { base: p.transferFee.base?.bps ?? 0, quote: p.transferFee.quote?.bps ?? 0 },
    formulaAssurance: "program_source",
    fees: [
      `trade fee ${pct(p.tradeFeeRate)} (ceil) on the input`,
      p.creatorFeeRate > 0n ? `creator fee ${pct(p.creatorFeeRate)} (${p.creatorFeeOn === 0 ? "both tokens" : p.creatorFeeOn === 1 ? "token0 only" : "token1 only"}; on the input when the input is that token, else on the output)` : "creator fee disabled",
      `Token-2022 transfer fee: base ${tf(p.transferFee.base)}, quote ${tf(p.transferFee.quote)}`,
    ],
    unsupported: p.unsupported,
    dataComplete: true,
    assumptions: ["reserves are the vault balances minus the tracked protocol, fund and creator fees", "pool state frozen at the snapshot slot", "no concurrent trades, no slippage limit, no priority fee or tip"],
  };
}

export function createCpmmVenue(p: CpmmVenueParams): Venue {
  const info = describe(p);
  const reserveBase = () => (p.baseIsToken0 ? p.reserve0 : p.reserve1);
  const reserveQuote = () => (p.baseIsToken0 ? p.reserve1 : p.reserve0);

  const run = (userIn: bigint, inputIsToken0: boolean, tfIn: TransferFee | null, tfOut: TransferFee | null): SwapOutcome => {
    if (userIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "amount must be positive" };
    if (userIn > U64_MAX) return { ok: false, reason: "unsupported", detail: "amount exceeds the u64 range of token amounts" };
    const poolIn = userIn - transferFee(userIn, tfIn);
    if (poolIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "transfer fee consumes the whole amount" };
    const reserveIn = inputIsToken0 ? p.reserve0 : p.reserve1;
    const reserveOut = inputIsToken0 ? p.reserve1 : p.reserve0;
    if (reserveIn <= 0n || reserveOut <= 0n) return { ok: false, reason: "pool_depleted", detail: "a pool reserve is empty" };
    const r = cpmmSwapBaseInput(poolIn, reserveIn, reserveOut, p.tradeFeeRate, p.creatorFeeRate, p.protocolFeeRate, p.fundFeeRate, isCreatorFeeOnInput(p.creatorFeeOn, inputIsToken0));
    if (!r) return { ok: false, reason: "amount_too_small", detail: "the amount after fees produces no output" };
    const userOut = afterTransferFee(r.outputAmount, tfOut);
    if (userOut <= 0n) return { ok: false, reason: "amount_too_small", detail: "the output transfer fee consumes the whole output" };
    const next = createCpmmVenue({
      ...p,
      reserve0: inputIsToken0 ? r.newReserveIn : r.newReserveOut,
      reserve1: inputIsToken0 ? r.newReserveOut : r.newReserveIn,
    });
    return {
      ok: true,
      amountIn: userIn,
      amountOut: userOut,
      fees: { trade_fee_in: r.tradeFee, creator_fee: r.creatorFee, transfer_fee_in: transferFee(userIn, tfIn), transfer_fee_out: r.outputAmount - userOut },
      next,
    };
  };

  return {
    info,
    spot: (): Ratio => ({ num: reserveQuote(), den: reserveBase() }),
    // buying the base token = paying the quote token; the input is token0 exactly when the quote is token0 (base is token1)
    buy: (quoteIn) => run(quoteIn, !p.baseIsToken0, p.transferFee.quote, p.transferFee.base),
    sell: (baseIn) => run(baseIn, p.baseIsToken0, p.transferFee.base, p.transferFee.quote),
  };
}
