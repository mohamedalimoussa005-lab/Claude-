/**
 * Builds a Venue from raw account bytes (as returned by getMultipleAccounts / getProgramAccounts).
 * Pure: the caller fetches the accounts; nothing here reads a network.
 */

import { base64ToBytes } from "./bytes.ts";
import { createClmmVenue } from "./clmm.ts";
import { createCpmmVenue } from "./cpmm.ts";
import { decodeClmmConfig, decodeClmmPool, decodeCpmmConfig, decodeCpmmPool, decodeMint, decodePumpFeeConfig, decodePumpGlobalConfig, decodePumpPool, decodeTickArray, decodeTokenAccount } from "./decode.ts";
import type { MintData, TickArrayData } from "./decode.ts";
import { createPumpVenue } from "./pumpswap.ts";
import { feeAtEpoch } from "./token2022.ts";
import type { TransferFee } from "./token2022.ts";
import type { Venue } from "./types.ts";

export interface RawAccount {
  /** Program that owns the account. */
  owner: string;
  /** Base64 account data. */
  data: string;
}

export type AccountMap = Record<string, RawAccount | null | undefined>;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

function need(accounts: AccountMap, address: string, what: string): Uint8Array {
  const a = accounts[address];
  if (!a) throw new SnapshotError(`missing account ${what} (${address})`);
  return base64ToBytes(a.data);
}

/** The Token-2022 transfer fee in force at `epoch` for a mint, or null (legacy mint / no extension). */
function feeOfMint(accounts: AccountMap, mint: string, epoch: bigint): { fee: TransferFee | null; data: MintData } {
  const data = decodeMint(need(accounts, mint, "mint"));
  return { fee: data.transferFee ? feeAtEpoch(data.transferFee, epoch) : null, data };
}

export interface BuiltVenue {
  venue: Venue;
  baseSupply: bigint;
  baseMintData: MintData;
  quoteMintData: MintData;
  /** Facts about the pool read while building it (for the evidence ledger). */
  observed: Record<string, string | number | boolean | null>;
}

const SWAP_DISABLED_CLMM = 1 << 4; // pool.status bit 4 set = swap disabled
const SWAP_DISABLED_CPMM = 1 << 2; // pool.status bit 2 set = swap disabled

export interface ClmmSnapshotInput {
  poolAddress: string;
  baseMint: string;
  accounts: AccountMap;
  /** Base64 tick-array accounts. */
  tickArrays: string[];
  /** True when `tickArrays` holds every tick array of the pool (e.g. getProgramAccounts by pool id). */
  ticksComplete: boolean;
  epoch: bigint;
}

export function buildClmmVenue(i: ClmmSnapshotInput): BuiltVenue {
  const pool = decodeClmmPool(need(i.accounts, i.poolAddress, "CLMM pool"));
  if (pool.mint0 !== i.baseMint && pool.mint1 !== i.baseMint) throw new SnapshotError("the base mint is not one of the pool's mints");
  const baseIsToken0 = pool.mint0 === i.baseMint;
  const quoteMint = baseIsToken0 ? pool.mint1 : pool.mint0;
  const config = decodeClmmConfig(need(i.accounts, pool.ammConfig, "CLMM AmmConfig"));
  const arrays: TickArrayData[] = i.tickArrays.map((b) => decodeTickArray(base64ToBytes(b)));
  for (const a of arrays) if (a.poolId !== i.poolAddress) throw new SnapshotError(`tick array ${a.startTickIndex} belongs to another pool`);
  const ticks = arrays.flatMap((a) => a.initializedTicks);
  const base = feeOfMint(i.accounts, i.baseMint, i.epoch);
  const quote = feeOfMint(i.accounts, quoteMint, i.epoch);
  const unsupported: string[] = [];
  if (pool.dynamicFeeActive) unsupported.push("dynamic fees are configured on this pool (not simulated)");
  if (ticks.some((t) => t.hasLimitOrders)) unsupported.push("ticks carry limit orders (not simulated)");
  if ((pool.status & SWAP_DISABLED_CLMM) !== 0) unsupported.push("swaps are disabled in the pool status");
  const venue = createClmmVenue({
    poolAddress: i.poolAddress,
    baseMint: i.baseMint,
    quoteMint,
    baseDecimals: baseIsToken0 ? pool.decimals0 : pool.decimals1,
    quoteDecimals: baseIsToken0 ? pool.decimals1 : pool.decimals0,
    baseIsToken0,
    sqrtPriceX64: pool.sqrtPriceX64,
    liquidity: pool.liquidity,
    tickCurrent: pool.tickCurrent,
    feeRate: config.tradeFeeRate,
    feeOn: pool.feeOn,
    ticks: ticks.map((t) => ({ tick: t.tick, liquidityNet: t.liquidityNet })),
    ticksComplete: i.ticksComplete,
    unsupported,
    transferFee: { base: base.fee, quote: quote.fee },
  });
  return {
    venue,
    baseSupply: base.data.supply,
    baseMintData: base.data,
    quoteMintData: quote.data,
    observed: { liquidity: pool.liquidity.toString(), sqrtPriceX64: pool.sqrtPriceX64.toString(), tickCurrent: pool.tickCurrent, tickSpacing: pool.tickSpacing, feeRate: config.tradeFeeRate, feeOn: pool.feeOn, dynamicFeeActive: pool.dynamicFeeActive, tickArrays: arrays.length, initializedTicks: ticks.length, ticksComplete: i.ticksComplete },
  };
}

export interface CpmmSnapshotInput {
  poolAddress: string;
  baseMint: string;
  accounts: AccountMap;
  epoch: bigint;
}

export function buildCpmmVenue(i: CpmmSnapshotInput): BuiltVenue {
  const pool = decodeCpmmPool(need(i.accounts, i.poolAddress, "CPMM pool"));
  if (pool.mint0 !== i.baseMint && pool.mint1 !== i.baseMint) throw new SnapshotError("the base mint is not one of the pool's mints");
  const baseIsToken0 = pool.mint0 === i.baseMint;
  const quoteMint = baseIsToken0 ? pool.mint1 : pool.mint0;
  const config = decodeCpmmConfig(need(i.accounts, pool.ammConfig, "CPMM AmmConfig"));
  const vault0 = decodeTokenAccount(need(i.accounts, pool.vault0, "vault 0")).amount;
  const vault1 = decodeTokenAccount(need(i.accounts, pool.vault1, "vault 1")).amount;
  const fees0 = pool.protocolFees0 + pool.fundFees0 + pool.creatorFees0;
  const fees1 = pool.protocolFees1 + pool.fundFees1 + pool.creatorFees1;
  if (vault0 < fees0 || vault1 < fees1) throw new SnapshotError("vault balance is below the tracked fees (inconsistent snapshot)");
  const base = feeOfMint(i.accounts, i.baseMint, i.epoch);
  const quote = feeOfMint(i.accounts, quoteMint, i.epoch);
  const venue = createCpmmVenue({
    poolAddress: i.poolAddress,
    baseMint: i.baseMint,
    quoteMint,
    baseDecimals: baseIsToken0 ? pool.decimals0 : pool.decimals1,
    quoteDecimals: baseIsToken0 ? pool.decimals1 : pool.decimals0,
    baseIsToken0,
    reserve0: vault0 - fees0,
    reserve1: vault1 - fees1,
    tradeFeeRate: config.tradeFeeRate,
    protocolFeeRate: config.protocolFeeRate,
    fundFeeRate: config.fundFeeRate,
    creatorFeeRate: pool.enableCreatorFee ? config.creatorFeeRate : 0n,
    creatorFeeOn: pool.creatorFeeOn,
    unsupported: (pool.status & SWAP_DISABLED_CPMM) !== 0 ? ["swaps are disabled in the pool status"] : [],
    transferFee: { base: base.fee, quote: quote.fee },
  });
  return {
    venue,
    baseSupply: base.data.supply,
    baseMintData: base.data,
    quoteMintData: quote.data,
    observed: { vault0: vault0.toString(), vault1: vault1.toString(), reserve0: (vault0 - fees0).toString(), reserve1: (vault1 - fees1).toString(), tradeFeeRate: config.tradeFeeRate.toString(), creatorFeeRate: (pool.enableCreatorFee ? config.creatorFeeRate : 0n).toString(), creatorFeeOn: pool.creatorFeeOn, enableCreatorFee: pool.enableCreatorFee, protocolFees0: pool.protocolFees0.toString(), protocolFees1: pool.protocolFees1.toString(), fundFees0: pool.fundFees0.toString(), fundFees1: pool.fundFees1.toString(), creatorFees0: pool.creatorFees0.toString(), creatorFees1: pool.creatorFees1.toString() },
  };
}

export interface PumpSnapshotInput {
  poolAddress: string;
  accounts: AccountMap;
  globalConfigAddress: string;
  feeConfigAddress: string | null;
  /** PDA ["pool-authority", base_mint] of the Pump program, computed by the caller. */
  canonicalCreator: string;
  epoch: bigint;
}

export function buildPumpVenue(i: PumpSnapshotInput): BuiltVenue {
  const pool = decodePumpPool(need(i.accounts, i.poolAddress, "Pump pool"));
  const global = decodePumpGlobalConfig(need(i.accounts, i.globalConfigAddress, "Pump GlobalConfig"));
  const feeConfig = i.feeConfigAddress && i.accounts[i.feeConfigAddress] ? decodePumpFeeConfig(need(i.accounts, i.feeConfigAddress, "Pump FeeConfig")) : null;
  const baseVault = decodeTokenAccount(need(i.accounts, pool.baseVault, "pool base vault")).amount;
  const quoteVault = decodeTokenAccount(need(i.accounts, pool.quoteVault, "pool quote vault")).amount;
  const base = feeOfMint(i.accounts, pool.baseMint, i.epoch);
  const quote = feeOfMint(i.accounts, pool.quoteMint, i.epoch);
  if (quoteVault + pool.virtualQuoteReserves < 0n) throw new SnapshotError("effective quote reserves are negative (inconsistent snapshot)");
  const venue = createPumpVenue({
    poolAddress: i.poolAddress,
    baseMint: pool.baseMint,
    quoteMint: pool.quoteMint,
    baseDecimals: base.data.decimals,
    quoteDecimals: quote.data.decimals,
    baseReserve: baseVault,
    quoteVault,
    virtualQuoteReserves: pool.virtualQuoteReserves,
    protocolFees: pool.protocolFees,
    creatorFees: pool.creatorFees,
    unsupported: feeConfig ? [] : ["fee program account unavailable: global config rates used"],
    feeContext: { global, feeConfig, poolCreator: pool.creator, canonicalCreator: i.canonicalCreator, baseMint: pool.baseMint, quoteMint: pool.quoteMint, coinCreator: pool.coinCreator, isMayhemMode: pool.isMayhemMode, poolCreatorFeeBps: pool.creatorFeeBps, baseMintSupply: base.data.supply },
    transferFee: { base: base.fee, quote: quote.fee },
  });
  return {
    venue,
    baseSupply: base.data.supply,
    baseMintData: base.data,
    quoteMintData: quote.data,
    observed: { baseReserve: baseVault.toString(), quoteVault: quoteVault.toString(), virtualQuoteReserves: pool.virtualQuoteReserves.toString(), protocolFees: pool.protocolFees.toString(), creatorFees: pool.creatorFees.toString(), effectiveQuoteReserves: (quoteVault + pool.virtualQuoteReserves).toString(), realQuoteReserves: (quoteVault - pool.protocolFees - pool.creatorFees).toString(), canonicalPool: pool.creator === i.canonicalCreator, coinCreatorSet: pool.coinCreator !== "11111111111111111111111111111111", isMayhemMode: pool.isMayhemMode },
  };
}
