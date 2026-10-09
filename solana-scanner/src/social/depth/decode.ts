/**
 * Pure decoders for the on-chain accounts the depth engine reads. Layouts follow the
 * open-source programs (Raydium CLMM / CP-Swap, master as of 2026-10-09) and Pump's public IDL
 * (pump_amm.json, pump_fees.json). Each decoder only reads fields that exist in the data and
 * never invents a default for a missing required field (it throws).
 */

import { Reader } from "./bytes.ts";
import type { TransferFeeSchedule } from "./token2022.ts";

// ───────────────────────── SPL token / Token-2022 ─────────────────────────

export interface TokenAccountData {
  mint: string;
  owner: string;
  amount: bigint;
}

export function decodeTokenAccount(bytes: Uint8Array): TokenAccountData {
  const r = new Reader(bytes);
  return { mint: r.pubkey(0), owner: r.pubkey(32), amount: r.u64(64) };
}

export interface MintData {
  supply: bigint;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension type ids present (empty for the legacy program). */
  extensionTypes: number[];
  transferFee: TransferFeeSchedule | null;
  transferFeeConfigAuthority: string | null;
  permanentDelegate: string | null;
  /** Program id of a configured transfer hook (the system program id means "none"). */
  transferHookProgram: string | null;
}

const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export function decodeMint(bytes: Uint8Array): MintData {
  const r = new Reader(bytes);
  const mintAuthority = r.u32(0) === 1 ? r.pubkey(4) : null;
  const freezeAuthority = r.u32(46) === 1 ? r.pubkey(50) : null;
  const out: MintData = {
    supply: r.u64(36),
    decimals: r.u8(44),
    mintAuthority,
    freezeAuthority,
    extensionTypes: [],
    transferFee: null,
    transferFeeConfigAuthority: null,
    permanentDelegate: null,
    transferHookProgram: null,
  };
  if (bytes.length > 165) {
    if (r.u8(165) !== 1) throw new RangeError("Token-2022 account is not a mint (AccountType != 1)");
    let o = 166;
    while (o + 4 <= bytes.length) {
      const type = r.u16(o);
      const len = r.u16(o + 2);
      const v = o + 4;
      if (v + len > bytes.length) throw new RangeError("truncated Token-2022 extension");
      out.extensionTypes.push(type);
      if (type === EXT_TRANSFER_FEE_CONFIG && len >= 108) {
        out.transferFeeConfigAuthority = r.allZero(v, 32) ? null : r.pubkey(v);
        out.transferFee = {
          olderEpoch: r.u64(v + 72),
          olderMax: r.u64(v + 80),
          olderBps: r.u16(v + 88),
          newerEpoch: r.u64(v + 90),
          newerMax: r.u64(v + 98),
          newerBps: r.u16(v + 106),
        };
      } else if (type === EXT_PERMANENT_DELEGATE && len >= 32) {
        out.permanentDelegate = r.allZero(v, 32) ? null : r.pubkey(v);
      } else if (type === EXT_TRANSFER_HOOK && len >= 64) {
        const program = r.pubkey(v + 32);
        out.transferHookProgram = program === SYSTEM_PROGRAM ? null : program;
      }
      o = v + len;
    }
  }
  return out;
}

// ───────────────────────── Raydium CLMM ─────────────────────────

export interface ClmmPoolData {
  ammConfig: string;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  status: number;
  /** 0 = FromInput, 1 = Token0Only, 2 = Token1Only. */
  feeOn: number;
  /** True when DynamicFeeInfo holds any non-zero byte (dynamic fees configured). */
  dynamicFeeActive: boolean;
}

export const CLMM_POOL_LEN = 1544;

export function decodeClmmPool(bytes: Uint8Array): ClmmPoolData {
  if (bytes.length !== CLMM_POOL_LEN) throw new RangeError(`CLMM pool account must be ${CLMM_POOL_LEN} bytes, got ${bytes.length}`);
  const r = new Reader(bytes);
  return {
    ammConfig: r.pubkey(9),
    mint0: r.pubkey(73),
    mint1: r.pubkey(105),
    vault0: r.pubkey(137),
    vault1: r.pubkey(169),
    decimals0: r.u8(233),
    decimals1: r.u8(234),
    tickSpacing: r.u16(235),
    liquidity: r.u128(237),
    sqrtPriceX64: r.u128(253),
    tickCurrent: r.i32(269),
    status: r.u8(389),
    feeOn: r.u8(390),
    dynamicFeeActive: !r.allZero(1096, 80),
  };
}

export interface ClmmConfigData {
  tradeFeeRate: number;
  protocolFeeRate: number;
  fundFeeRate: number;
  tickSpacing: number;
}

export function decodeClmmConfig(bytes: Uint8Array): ClmmConfigData {
  const r = new Reader(bytes);
  return { protocolFeeRate: r.u32(43), tradeFeeRate: r.u32(47), tickSpacing: r.u16(51), fundFeeRate: r.u32(53) };
}

export interface InitializedTick {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  /** True when the tick carries limit orders (a feature this engine does not simulate). */
  hasLimitOrders: boolean;
}

export interface TickArrayData {
  poolId: string;
  startTickIndex: number;
  initializedTicks: InitializedTick[];
}

export const TICK_ARRAY_LEN = 10240;
const TICK_ARRAY_SIZE = 60;
const TICK_STATE_LEN = 168;

export function decodeTickArray(bytes: Uint8Array): TickArrayData {
  if (bytes.length !== TICK_ARRAY_LEN) throw new RangeError(`tick array account must be ${TICK_ARRAY_LEN} bytes, got ${bytes.length}`);
  const r = new Reader(bytes);
  const ticks: InitializedTick[] = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
    const o = 44 + i * TICK_STATE_LEN;
    const gross = r.u128(o + 20);
    if (gross === 0n) continue;
    ticks.push({ tick: r.i32(o), liquidityNet: r.i128(o + 4), liquidityGross: gross, hasLimitOrders: r.u64(o + 124) !== 0n || r.u64(o + 132) !== 0n });
  }
  return { poolId: r.pubkey(8), startTickIndex: r.i32(40), initializedTicks: ticks };
}

// ───────────────────────── Raydium CP-Swap (CPMM) ─────────────────────────

export interface CpmmPoolData {
  ammConfig: string;
  vault0: string;
  vault1: string;
  mint0: string;
  mint1: string;
  decimals0: number;
  decimals1: number;
  status: number;
  openTime: bigint;
  protocolFees0: bigint;
  protocolFees1: bigint;
  fundFees0: bigint;
  fundFees1: bigint;
  /** 0 = both tokens, 1 = token0 only, 2 = token1 only. */
  creatorFeeOn: number;
  enableCreatorFee: boolean;
  creatorFees0: bigint;
  creatorFees1: bigint;
}

export function decodeCpmmPool(bytes: Uint8Array): CpmmPoolData {
  const r = new Reader(bytes);
  return {
    ammConfig: r.pubkey(8),
    vault0: r.pubkey(72),
    vault1: r.pubkey(104),
    mint0: r.pubkey(168),
    mint1: r.pubkey(200),
    status: r.u8(329),
    decimals0: r.u8(331),
    decimals1: r.u8(332),
    protocolFees0: r.u64(341),
    protocolFees1: r.u64(349),
    fundFees0: r.u64(357),
    fundFees1: r.u64(365),
    openTime: r.u64(373),
    creatorFeeOn: r.has(389, 1) ? r.u8(389) : 0,
    enableCreatorFee: r.has(390, 1) ? r.u8(390) === 1 : false,
    creatorFees0: r.has(397, 8) ? r.u64(397) : 0n,
    creatorFees1: r.has(405, 8) ? r.u64(405) : 0n,
  };
}

export interface CpmmConfigData {
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  creatorFeeRate: bigint;
}

export function decodeCpmmConfig(bytes: Uint8Array): CpmmConfigData {
  const r = new Reader(bytes);
  return { tradeFeeRate: r.u64(12), protocolFeeRate: r.u64(20), fundFeeRate: r.u64(28), creatorFeeRate: r.has(108, 8) ? r.u64(108) : 0n };
}

// ───────────────────────── PumpSwap (Pump AMM) ─────────────────────────

export interface PumpPoolData {
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
  isMayhemMode: boolean;
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  protocolFees: bigint;
  creatorFees: bigint;
}

export function decodePumpPool(bytes: Uint8Array): PumpPoolData {
  const r = new Reader(bytes);
  return {
    creator: r.pubkey(11),
    baseMint: r.pubkey(43),
    quoteMint: r.pubkey(75),
    baseVault: r.pubkey(139),
    quoteVault: r.pubkey(171),
    coinCreator: r.has(211, 32) ? r.pubkey(211) : SYSTEM_PROGRAM,
    isMayhemMode: r.has(243, 1) ? r.u8(243) === 1 : false,
    // Fields appended by later upgrades read as 0 on pools written before them (Pump docs).
    virtualQuoteReserves: r.has(245, 16) ? r.i128(245) : 0n,
    creatorFeeBps: r.has(261, 8) ? r.u64(261) : 0n,
    protocolFees: r.has(271, 8) ? r.u64(271) : 0n,
    creatorFees: r.has(279, 8) ? r.u64(279) : 0n,
  };
}

export interface PumpGlobalConfigData {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  coinCreatorFeeBps: bigint;
  creatorFeeConfigurable: boolean;
}

export function decodePumpGlobalConfig(bytes: Uint8Array): PumpGlobalConfigData {
  const r = new Reader(bytes);
  return { lpFeeBps: r.u64(40), protocolFeeBps: r.u64(48), coinCreatorFeeBps: r.u64(313), creatorFeeConfigurable: r.has(940, 1) ? r.u8(940) === 1 : false };
}

export interface PumpFees {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

export interface PumpFeeTier {
  marketCapLamportsThreshold: bigint;
  fees: PumpFees;
}

export interface PumpFeeConfigData {
  flatFees: PumpFees;
  feeTiers: PumpFeeTier[];
  stableFeeTiers: PumpFeeTier[];
  exoticFlatFees: PumpFees;
}

export function decodePumpFeeConfig(bytes: Uint8Array): PumpFeeConfigData {
  const r = new Reader(bytes);
  let o = 8 + 1 + 32; // discriminator, bump, admin
  const fees = (): PumpFees => {
    const f = { lpFeeBps: r.u64(o), protocolFeeBps: r.u64(o + 8), creatorFeeBps: r.u64(o + 16) };
    o += 24;
    return f;
  };
  const tiers = (): PumpFeeTier[] => {
    const n = r.u32(o);
    o += 4;
    const out: PumpFeeTier[] = [];
    for (let i = 0; i < n; i++) {
      const marketCapLamportsThreshold = r.u128(o);
      o += 16;
      out.push({ marketCapLamportsThreshold, fees: fees() });
    }
    return out;
  };
  const flatFees = fees();
  const feeTiers = tiers();
  const stableFeeTiers = tiers();
  const exoticFlatFees = fees();
  return { flatFees, feeTiers, stableFeeTiers, exoticFlatFees };
}
