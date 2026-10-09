/**
 * PumpSwap (Pump AMM) exact-input swap simulation.
 *
 * The program (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) is not open source. Formulas are the
 * vendor's official SDK (@pump-fun/pump-swap-sdk 2.1.0: buyQuoteInput, sellBaseInput, computeFeesBps,
 * calculateFeeTier) and pump-fun/pump-public-docs (PUMP_SWAP_README, VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT,
 * FEE_PROGRAM_README), read on 2026-10-09. Result status is therefore "official SDK", not "program source".
 *
 * Fees differ from CP-Swap / CLMM: LP + protocol + creator basis points (all ceil on the base amount),
 * charged on the quote INPUT when buying and deducted from the quote OUTPUT when selling, with a
 * market-cap tiered schedule read from the fee-program FeeConfig account for canonical pools.
 *
 * Reserves: the price uses EFFECTIVE quote reserves (vault + virtual_quote_reserves). Only REAL
 * quote reserves (vault − protocol_fees − creator_fees) can be paid out: a sell larger than the real
 * reserves cannot execute, even though the price formula would accept it. This matters when a pool
 * carries a boost (virtual reserves > the waiting fees).
 */

import { divCeil, U64_MAX } from "./math.ts";
import type { Ratio } from "./math.ts";
import { afterTransferFee, transferFee } from "./token2022.ts";
import type { TransferFee } from "./token2022.ts";
import type { PumpFeeConfigData, PumpFees, PumpFeeTier, PumpGlobalConfigData } from "./decode.ts";
import type { SwapOutcome, Venue, VenueInfo } from "./types.ts";

const BPS = 10_000n;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Total token supply Pump uses as circulating supply in mayhem mode (SDK PUMP_AMM_TOTAL_TOKEN_SUPPLY). */
const MAYHEM_SUPPLY = 1_000_000_000_000_000n;

const feeBps = (amount: bigint, bps: bigint): bigint => divCeil(amount * bps, BPS);

/** SDK calculateFeeTier: the last tier whose threshold the market cap has reached (first tier below all). */
export function calculateFeeTier(tiers: PumpFeeTier[], marketCap: bigint): PumpFees {
  if (tiers.length === 0) throw new RangeError("fee tiers cannot be empty");
  if (marketCap < tiers[0]!.marketCapLamportsThreshold) return tiers[0]!.fees;
  for (let i = tiers.length - 1; i >= 0; i--) if (marketCap >= tiers[i]!.marketCapLamportsThreshold) return tiers[i]!.fees;
  return tiers[0]!.fees;
}

export interface PumpFeeContext {
  global: PumpGlobalConfigData;
  /** null when the fee program account is not available: the global config rates are used. */
  feeConfig: PumpFeeConfigData | null;
  poolCreator: string;
  /** PDA ["pool-authority", base_mint] of the Pump program: a pool created by it is canonical. */
  canonicalCreator: string;
  baseMint: string;
  quoteMint: string;
  coinCreator: string;
  isMayhemMode: boolean;
  /** Pool.creator_fee_bps, only used when the global config allows configurable creator fees. */
  poolCreatorFeeBps: bigint;
  baseMintSupply: bigint;
}

export type PumpQuoteKind = "sol" | "stable" | "other";

export function pumpQuoteKind(quoteMint: string): PumpQuoteKind {
  if (quoteMint === WSOL || quoteMint === SYSTEM_PROGRAM) return "sol";
  if (quoteMint === USDC) return "stable";
  return "other";
}

/** SDK computeFeesBps + feesForQuoteMint (+ creator fee 0 when the pool has no coin creator). */
export function resolvePumpFees(ctx: PumpFeeContext, baseReserve: bigint, effectiveQuote: bigint): { fees: PumpFees; schedule: string } {
  let fees: PumpFees;
  let schedule: string;
  if (ctx.feeConfig) {
    const canonical = ctx.poolCreator === ctx.canonicalCreator;
    const supply = ctx.isMayhemMode ? MAYHEM_SUPPLY : ctx.baseMintSupply;
    const marketCap = baseReserve === 0n ? 0n : (effectiveQuote * supply) / baseReserve;
    const kind = pumpQuoteKind(ctx.quoteMint);
    if (!canonical) {
      fees = ctx.feeConfig.flatFees;
      schedule = "flat fees (non-canonical pool)";
    } else if (kind === "sol") {
      fees = calculateFeeTier(ctx.feeConfig.feeTiers, marketCap);
      schedule = `market-cap tier (SOL quote), market cap ${marketCap} lamports`;
    } else if (kind === "stable") {
      fees = calculateFeeTier(ctx.feeConfig.stableFeeTiers.length > 0 ? ctx.feeConfig.stableFeeTiers : ctx.feeConfig.feeTiers, marketCap);
      schedule = "market-cap tier (stable quote)";
    } else {
      const ex = ctx.feeConfig.exoticFlatFees;
      fees = ex.lpFeeBps === 0n && ex.protocolFeeBps === 0n && ex.creatorFeeBps === 0n ? ctx.feeConfig.flatFees : ex;
      schedule = "flat fees (other quote mint)";
    }
    if (ctx.global.creatorFeeConfigurable && ctx.poolCreatorFeeBps > 0n) fees = { ...fees, creatorFeeBps: ctx.poolCreatorFeeBps };
  } else {
    fees = { lpFeeBps: ctx.global.lpFeeBps, protocolFeeBps: ctx.global.protocolFeeBps, creatorFeeBps: ctx.global.coinCreatorFeeBps };
    schedule = "global config rates (fee program account unavailable)";
  }
  if (ctx.coinCreator === SYSTEM_PROGRAM) fees = { ...fees, creatorFeeBps: 0n };
  return { fees, schedule };
}

export interface PumpVenueParams {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseReserve: bigint;
  /** Raw quote vault balance (includes fees waiting to be swept). */
  quoteVault: bigint;
  virtualQuoteReserves: bigint;
  protocolFees: bigint;
  creatorFees: bigint;
  feeContext: PumpFeeContext;
  /** Features this engine does not simulate, or data that was unavailable. */
  unsupported: string[];
  transferFee: { base: TransferFee | null; quote: TransferFee | null };
}

export const effectiveQuote = (p: Pick<PumpVenueParams, "quoteVault" | "virtualQuoteReserves">): bigint => p.quoteVault + p.virtualQuoteReserves;
export const realQuote = (p: Pick<PumpVenueParams, "quoteVault" | "protocolFees" | "creatorFees">): bigint => p.quoteVault - p.protocolFees - p.creatorFees;

function describe(p: PumpVenueParams): VenueInfo {
  const eff = effectiveQuote(p);
  const { fees, schedule } = resolvePumpFees(p.feeContext, p.baseReserve, eff);
  const total = fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps;
  const boost = p.virtualQuoteReserves + p.protocolFees + p.creatorFees;
  const tf = (x: TransferFee | null) => (x ? `${x.bps / 100} %` : "none");
  return {
    kind: "pumpswap",
    poolAddress: p.poolAddress,
    baseMint: p.baseMint,
    quoteMint: p.quoteMint,
    baseDecimals: p.baseDecimals,
    quoteDecimals: p.quoteDecimals,
    transferTaxBps: { base: p.transferFee.base?.bps ?? 0, quote: p.transferFee.quote?.bps ?? 0 },
    formulaAssurance: "official_sdk",
    fees: [`LP ${fees.lpFeeBps} + protocol ${fees.protocolFeeBps} + creator ${fees.creatorFeeBps} = ${total} bps (${schedule})`, `Token-2022 transfer fee: base ${tf(p.transferFee.base)}, quote ${tf(p.transferFee.quote)}`, boost !== 0n ? `boosted pool: ${boost} raw quote units of virtual reserves are priced but cannot be paid out` : "no boost reserves"],
    unsupported: p.unsupported,
    dataComplete: true,
    assumptions: ["program source is not public: formulas are the official SDK's", "fee tier is re-evaluated from the pool reserves before every swap", "pool state frozen at the snapshot slot", "no concurrent trades, no slippage limit, no priority fee or tip"],
  };
}

export function createPumpVenue(p: PumpVenueParams): Venue {
  const info = describe(p);
  const eff = effectiveQuote(p);
  const real = realQuote(p);

  const buy = (userIn: bigint): SwapOutcome => {
    if (userIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "amount must be positive" };
    if (userIn > U64_MAX) return { ok: false, reason: "unsupported", detail: "amount exceeds the u64 range of token amounts" };
    if (p.baseReserve <= 0n || eff <= 0n) return { ok: false, reason: "pool_depleted", detail: "a pool reserve is empty" };
    const spend = userIn - transferFee(userIn, p.transferFee.quote);
    if (spend <= 0n) return { ok: false, reason: "amount_too_small", detail: "transfer fee consumes the whole amount" };
    const { fees } = resolvePumpFees(p.feeContext, p.baseReserve, eff);
    const total = fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps;
    // SDK buyQuoteInput: net = spend × 10000 / (10000 + total bps); fees are ceil on net; trim any excess.
    let net = (spend * BPS) / (BPS + total);
    const lpFee = feeBps(net, fees.lpFeeBps);
    const protocolFee = feeBps(net, fees.protocolFeeBps);
    const creatorFee = feeBps(net, fees.creatorFeeBps);
    const excess = net + lpFee + protocolFee + creatorFee - spend;
    if (excess > 0n) net -= excess;
    if (net <= 0n) return { ok: false, reason: "fees_exceed_amount", detail: "the amount does not cover the fees" };
    const input = net - 1n; // the SDK's estimator keeps one raw unit of margin
    if (input <= 0n) return { ok: false, reason: "amount_too_small", detail: "amount too small after fees" };
    const baseOut = (p.baseReserve * input) / (eff + input);
    if (baseOut <= 0n) return { ok: false, reason: "amount_too_small", detail: "output rounds to zero" };
    if (baseOut >= p.baseReserve) return { ok: false, reason: "pool_depleted", detail: "the swap would empty the base reserve" };
    const userOut = afterTransferFee(baseOut, p.transferFee.base);
    if (userOut <= 0n) return { ok: false, reason: "amount_too_small", detail: "the output transfer fee consumes the whole output" };
    return {
      ok: true,
      amountIn: userIn,
      amountOut: userOut,
      fees: { lp_fee_quote: lpFee, protocol_fee_quote: protocolFee, creator_fee_quote: creatorFee, transfer_fee_in: transferFee(userIn, p.transferFee.quote), transfer_fee_out: baseOut - userOut },
      // The LP fee stays in the pool; protocol and creator fees leave the pricing reserves (paid out, or kept and netted from the virtual reserves).
      next: createPumpVenue({ ...p, baseReserve: p.baseReserve - baseOut, quoteVault: p.quoteVault + net + lpFee }),
    };
  };

  const sell = (userIn: bigint): SwapOutcome => {
    if (userIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "amount must be positive" };
    if (userIn > U64_MAX) return { ok: false, reason: "unsupported", detail: "amount exceeds the u64 range of token amounts" };
    if (p.baseReserve <= 0n || eff <= 0n) return { ok: false, reason: "pool_depleted", detail: "a pool reserve is empty" };
    const baseIn = userIn - transferFee(userIn, p.transferFee.base);
    if (baseIn <= 0n) return { ok: false, reason: "amount_too_small", detail: "transfer fee consumes the whole amount" };
    const { fees } = resolvePumpFees(p.feeContext, p.baseReserve, eff);
    const quoteOut = (eff * baseIn) / (p.baseReserve + baseIn);
    const lpFee = feeBps(quoteOut, fees.lpFeeBps);
    const protocolFee = feeBps(quoteOut, fees.protocolFeeBps);
    const creatorFee = feeBps(quoteOut, fees.creatorFeeBps);
    const withoutLp = quoteOut - lpFee;
    if (real < withoutLp) return { ok: false, reason: "insufficient_real_reserves", detail: `the pool prices ${quoteOut} but can only pay ${real} (real quote reserves)` };
    const userQuote = withoutLp - creatorFee - protocolFee;
    if (userQuote <= 0n) return { ok: false, reason: "fees_exceed_amount", detail: "fees exceed the output" };
    const received = afterTransferFee(userQuote, p.transferFee.quote);
    if (received <= 0n) return { ok: false, reason: "amount_too_small", detail: "the output transfer fee consumes the whole output" };
    return {
      ok: true,
      amountIn: userIn,
      amountOut: received,
      fees: { lp_fee_quote: lpFee, protocol_fee_quote: protocolFee, creator_fee_quote: creatorFee, transfer_fee_in: transferFee(userIn, p.transferFee.base), transfer_fee_out: userQuote - received },
      next: createPumpVenue({ ...p, baseReserve: p.baseReserve + baseIn, quoteVault: p.quoteVault - withoutLp }),
    };
  };

  return { info, spot: (): Ratio => ({ num: eff, den: p.baseReserve }), buy, sell };
}

