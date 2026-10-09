import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode, base64ToBytes, Reader } from "../src/social/depth/bytes.ts";
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "../src/social/depth/clmm.ts";
import { decodeClmmConfig, decodeClmmPool, decodeCpmmConfig, decodeCpmmPool, decodeMint, decodePumpFeeConfig, decodePumpGlobalConfig, decodePumpPool, decodeTickArray, decodeTokenAccount } from "../src/social/depth/decode.ts";
import { divCeil, fromHuman, mulDivCeil, mulDivFloor, MathError, ratioGte, toHuman } from "../src/social/depth/math.ts";
import { MAX_SQRT_PRICE_X64, MAX_TICK, MIN_SQRT_PRICE_X64, MIN_TICK, TICK_RATIO_CONSTANTS } from "../src/social/depth/tickConstants.ts";
import { afterTransferFee, feeAtEpoch, transferFee } from "../src/social/depth/token2022.ts";
import { ACCOUNTS, EPOCH, F_TICK_ARRAYS, MINTS, POOLS, PUMP_CANONICAL_CREATOR, PUMP_FEE_CONFIG, PUMP_GLOBAL_CONFIG } from "./fixtures/social/depth/raw.ts";
import { bytesOf, poolAuthorityPda, prng } from "./helpers/depth.ts";

/** Depth engine building blocks: integer math, Token-2022 taxes, tick math, account decoders. No network. */

// ───────── integer math ─────────
test("mulDiv and divCeil round in the stated direction and never use floats", () => {
  assert.equal(mulDivFloor(10n, 10n, 3n), 33n);
  assert.equal(mulDivCeil(10n, 10n, 3n), 34n);
  assert.equal(mulDivCeil(9n, 10n, 3n), 30n);
  assert.equal(divCeil(7n, 2n), 4n);
  assert.equal(divCeil(8n, 2n), 4n);
  assert.equal(mulDivFloor(2n ** 100n, 2n ** 100n, 2n ** 100n), 2n ** 100n); // far beyond 2^53
  assert.throws(() => mulDivFloor(1n, 1n, 0n), (e: unknown) => e instanceof MathError && e.code === "division_by_zero");
  assert.throws(() => mulDivCeil(-1n, 1n, 1n), (e: unknown) => e instanceof MathError && e.code === "negative");
});

test("ratios compare exactly; human conversions round trip", () => {
  assert.ok(ratioGte({ num: 1n, den: 3n }, { num: 333333333333333333n, den: 1000000000000000000n }));
  assert.ok(!ratioGte({ num: 333333333333333332n, den: 1000000000000000000n }, { num: 1n, den: 3n }));
  assert.equal(fromHuman(0.1, 9), 100_000_000n);
  assert.equal(fromHuman(1.0000001, 6), 1_000_000n);
  assert.equal(toHuman(1_500_000n, 6), 1.5);
  assert.throws(() => fromHuman(-1, 6));
});

// ───────── Token-2022 transfer fee ─────────
test("transfer fee: ceil(amount × bps / 10 000) capped at the maximum, zero when nothing to charge", () => {
  const fee = { bps: 100, maximumFee: 1_000_000n };
  assert.equal(transferFee(1n, fee), 1n); // ceil
  assert.equal(transferFee(100n, fee), 1n);
  assert.equal(transferFee(101n, fee), 2n);
  assert.equal(transferFee(10_000_000_000n, fee), 1_000_000n); // capped
  assert.equal(transferFee(1000n, null), 0n);
  assert.equal(transferFee(1000n, { bps: 0, maximumFee: 5n }), 0n);
  assert.equal(transferFee(0n, fee), 0n);
  assert.equal(afterTransferFee(10_000n, fee), 9_900n);
});

test("the fee schedule switches from the older to the newer entry at its epoch", () => {
  const s = { olderEpoch: 1048n, olderBps: 500, olderMax: 99n, newerEpoch: 1050n, newerBps: 100, newerMax: 77n };
  assert.deepEqual(feeAtEpoch(s, 1049n), { bps: 500, maximumFee: 99n });
  assert.deepEqual(feeAtEpoch(s, 1050n), { bps: 100, maximumFee: 77n });
  assert.deepEqual(feeAtEpoch(s, 2000n), { bps: 100, maximumFee: 77n });
});

// ───────── bytes ─────────
test("base58 encoding matches a known address; the reader refuses out-of-range reads", () => {
  assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
  const r = new Reader(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 128]));
  assert.equal(r.u64(0), 1n << 63n | 1n);
  assert.equal(r.i128.length, 1);
  assert.throws(() => r.u64(1), RangeError);
  assert.throws(() => r.u8(8), RangeError);
  assert.throws(() => r.u8(-1), RangeError);
  assert.equal(new Reader(Uint8Array.from([255, 255, 255, 255])).i32(0), -1);
  assert.equal(new Reader(Uint8Array.from(Array(16).fill(255))).i128(0), -1n);
});

// ───────── tick math ─────────
test("tick math: constants extracted from the program, anchor values, bounds", () => {
  assert.equal(TICK_RATIO_CONSTANTS.length, 19);
  assert.equal(getSqrtPriceAtTick(0), 1n << 64n);
  assert.equal(getSqrtPriceAtTick(MIN_TICK), MIN_SQRT_PRICE_X64);
  assert.equal(getSqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE_X64);
  assert.throws(() => getSqrtPriceAtTick(MAX_TICK + 1), MathError);
  assert.throws(() => getSqrtPriceAtTick(MIN_TICK - 1), MathError);
  assert.throws(() => getSqrtPriceAtTick(1.5), MathError);
  assert.throws(() => getTickAtSqrtPrice(MAX_SQRT_PRICE_X64), MathError);
  assert.throws(() => getTickAtSqrtPrice(MIN_SQRT_PRICE_X64 - 1n), MathError);
});

test("tick math: sqrt price is strictly increasing and tracks 1.0001^(tick/2) (to 1e-10 relative; float pow is itself ~1e-12 off at |tick| ~ 2e5)", () => {
  const rng = prng(7);
  let prev = getSqrtPriceAtTick(-50_000);
  for (let t = -49_999; t <= -49_900; t++) {
    const cur = getSqrtPriceAtTick(t);
    assert.ok(cur > prev, `tick ${t}`);
    prev = cur;
  }
  for (let i = 0; i < 200; i++) {
    const t = Math.floor(rng() * 400_000) - 200_000;
    const exact = 1.0001 ** (t / 2) * 2 ** 64;
    const got = Number(getSqrtPriceAtTick(t));
    assert.ok(Math.abs(got - exact) / exact < 1e-10, `tick ${t}: ${got} vs ${exact}`);
  }
});

test("tick math: getTickAtSqrtPrice inverts getSqrtPriceAtTick, and a price just below a tick belongs to the tick below", () => {
  const rng = prng(11);
  const ticks = [MIN_TICK, -443_000, -33_784, -33_783, -29_732, -1, 0, 1, 12_345, 443_000, MAX_TICK - 1];
  for (let i = 0; i < 300; i++) ticks.push(Math.floor(rng() * 880_000) - 440_000);
  for (const t of ticks) {
    const s = getSqrtPriceAtTick(t);
    assert.equal(getTickAtSqrtPrice(s), t, `tick ${t}`);
    if (t > MIN_TICK) assert.equal(getTickAtSqrtPrice(s - 1n), t - 1, `tick ${t} − ε`);
  }
});

// ───────── decoders on the captured accounts ─────────
test("decoders: F's CLMM pool, its config, its ticks and its position agree with what the chain showed", () => {
  const pool = decodeClmmPool(bytesOf(POOLS.F));
  assert.equal(pool.mint0, MINTS.F);
  assert.equal(pool.mint1, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
  assert.equal(pool.tickSpacing, 1);
  assert.equal(pool.tickCurrent, -33784);
  assert.equal(pool.liquidity, 1000962964985175n);
  assert.equal(pool.feeOn, 0);
  assert.equal(pool.dynamicFeeActive, false);
  assert.equal(pool.decimals0, 6);
  assert.ok(pool.sqrtPriceX64 >= getSqrtPriceAtTick(pool.tickCurrent) && pool.sqrtPriceX64 < getSqrtPriceAtTick(pool.tickCurrent + 1), "the pool price lies inside its current tick");
  assert.equal(getTickAtSqrtPrice(pool.sqrtPriceX64), pool.tickCurrent);
  const cfg = decodeClmmConfig(bytesOf(pool.ammConfig));
  assert.deepEqual(cfg, { protocolFeeRate: 120000, tradeFeeRate: 100, tickSpacing: 1, fundFeeRate: 40000 });
  const arrays = Object.values(F_TICK_ARRAYS).map((b) => decodeTickArray(base64ToBytes(b)));
  assert.deepEqual(arrays.map((a) => a.startTickIndex).sort((x, y) => x - y), [-33840, -29760]);
  const ticks = arrays.flatMap((a) => a.initializedTicks).sort((x, y) => x.tick - y.tick);
  assert.deepEqual(ticks.map((t) => [t.tick, t.liquidityNet]), [[-33784, 1000962964985175n], [-29732, -1000962964985175n]]);
  assert.ok(ticks.every((t) => !t.hasLimitOrders));
  for (const a of arrays) assert.equal(a.poolId, POOLS.F);
});

test("decoders: F's position holds only 0.918 USDC of liquidity; the rest of the vault is not liquidity", () => {
  const pool = decodeClmmPool(bytesOf(POOLS.F));
  const L = pool.liquidity;
  const Q = 1n << 64n;
  const usdcInPosition = (L * (pool.sqrtPriceX64 - getSqrtPriceAtTick(-33784))) / Q;
  const aiInPosition = (L * Q * (getSqrtPriceAtTick(-29732) - pool.sqrtPriceX64)) / (pool.sqrtPriceX64 * getSqrtPriceAtTick(-29732));
  const v0 = decodeTokenAccount(bytesOf(pool.vault0)).amount;
  const v1 = decodeTokenAccount(bytesOf(pool.vault1)).amount;
  assert.equal(usdcInPosition, 918036n);
  assert.ok(v1 > 20n * usdcInPosition, "the USDC vault holds about 24× more than the position: accrued fees, not liquidity");
  assert.ok(Math.abs(Number(v0 - aiInPosition)) / Number(v0) < 1e-5, "the AI vault matches the position (plus a little accrued fees)");
});

test("decoders: B's CP-Swap pool, config and the two Token-2022 mints (transfer taxes and authorities)", () => {
  const pool = decodeCpmmPool(bytesOf(POOLS.B));
  assert.equal(pool.mint0, "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw");
  assert.equal(pool.mint1, MINTS.B);
  assert.equal(pool.enableCreatorFee, true);
  assert.equal(pool.creatorFeeOn, 1);
  const cfg = decodeCpmmConfig(bytesOf(pool.ammConfig));
  assert.deepEqual(cfg, { tradeFeeRate: 2500n, protocolFeeRate: 120000n, fundFeeRate: 40000n, creatorFeeRate: 10000n });
  assert.equal(decodeTokenAccount(bytesOf(pool.vault1)).owner, "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");

  const b = decodeMint(bytesOf(MINTS.B));
  assert.equal(b.mintAuthority, null);
  assert.equal(b.freezeAuthority, null);
  assert.deepEqual(b.extensionTypes, [18, 1, 19]);
  assert.equal(b.transferFee!.newerBps, 100);
  assert.equal(b.transferFeeConfigAuthority, "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD");

  const q = decodeMint(bytesOf(pool.mint0));
  assert.equal(q.decimals, 9);
  assert.equal(q.permanentDelegate, "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
  assert.equal(q.freezeAuthority, "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
  assert.equal(q.mintAuthority, "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
  assert.equal(q.transferHookProgram, null, "the hook program is the system program id = none");
  // 500 bps until epoch 1050, 100 bps from then on; the snapshot epoch is 1053
  assert.equal(feeAtEpoch(q.transferFee!, 1049n).bps, 500);
  assert.equal(feeAtEpoch(q.transferFee!, EPOCH).bps, 100);
});

test("decoders: PumpSwap pools, global config and the tiered fee schedule", () => {
  const g = decodePumpGlobalConfig(bytesOf(PUMP_GLOBAL_CONFIG));
  assert.deepEqual(g, { lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 5n, creatorFeeConfigurable: g.creatorFeeConfigurable });
  const fc = decodePumpFeeConfig(bytesOf(PUMP_FEE_CONFIG));
  assert.deepEqual(fc.flatFees, { lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n });
  assert.equal(fc.feeTiers.length, 25);
  assert.equal(fc.stableFeeTiers.length, 25);
  assert.deepEqual(fc.feeTiers[0], { marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 2n, protocolFeeBps: 93n, creatorFeeBps: 30n } });
  assert.equal(fc.feeTiers[1]!.marketCapLamportsThreshold, 420_000_000_000n);
  assert.ok(fc.feeTiers.every((t, i) => i === 0 || t.marketCapLamportsThreshold > fc.feeTiers[i - 1]!.marketCapLamportsThreshold), "thresholds strictly increase");
  for (const k of ["A", "C"] as const) {
    const p = decodePumpPool(bytesOf(POOLS[k]));
    assert.equal(p.baseMint, MINTS[k]);
    assert.equal(p.quoteMint, "So11111111111111111111111111111111111111112");
    assert.equal(p.creator, PUMP_CANONICAL_CREATOR[k]);
    assert.ok(p.virtualQuoteReserves > 17_000_000_000n, "boosted pool: 17.58 SOL of virtual reserves");
  }
});

test("the canonical Pump pool authority stored in the fixtures matches an independent PDA derivation", () => {
  for (const k of ["A", "C"] as const) assert.equal(poolAuthorityPda(MINTS[k]), PUMP_CANONICAL_CREATOR[k]);
});

test("decoders reject malformed data instead of guessing", () => {
  assert.throws(() => decodeClmmPool(new Uint8Array(100)), RangeError);
  assert.throws(() => decodeTickArray(new Uint8Array(100)), RangeError);
  assert.throws(() => decodeTokenAccount(new Uint8Array(10)), RangeError);
  const notMint = new Uint8Array(200);
  notMint[165] = 2; // AccountType::Account
  assert.throws(() => decodeMint(notMint), RangeError);
  // a Pump pool written before the appended fields reads them as absent (0), not as an error
  const short = bytesOf(POOLS.A).slice(0, 211 + 32);
  const p = decodePumpPool(short);
  assert.equal(p.virtualQuoteReserves, 0n);
  assert.equal(p.protocolFees, 0n);
});

test("fixtures are internally consistent (snapshot slot, tick-array slot, accounts present)", () => {
  assert.ok(Object.keys(ACCOUNTS).length >= 20);
  for (const [k, a] of Object.entries(ACCOUNTS)) assert.ok(a.data.length > 0 && a.owner.length >= 32, k);
  assert.equal(Object.keys(F_TICK_ARRAYS).length, 2);
});
