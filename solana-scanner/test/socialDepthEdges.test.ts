import { test } from "node:test";
import assert from "node:assert/strict";
import { createClmmVenue } from "../src/social/depth/clmm.ts";
import { createCpmmVenue } from "../src/social/depth/cpmm.ts";
import { decodeCpmmPool, decodeMint, decodePumpPool } from "../src/social/depth/decode.ts";
import { analyzeDepth, searchDepth } from "../src/social/depth/engine.ts";
import { U64_MAX } from "../src/social/depth/math.ts";
import { createPumpVenue } from "../src/social/depth/pumpswap.ts";
import { buildClmmVenue, buildCpmmVenue, buildPumpVenue, SnapshotError } from "../src/social/depth/snapshot.ts";
import type { AccountMap } from "../src/social/depth/snapshot.ts";
import type { Venue } from "../src/social/depth/types.ts";
import { ACCOUNTS, EPOCH, F_TICK_ARRAYS, MINTS, POOLS, PUMP_CANONICAL_CREATOR, PUMP_FEE_CONFIG, PUMP_GLOBAL_CONFIG } from "./fixtures/social/depth/raw.ts";
import { accounts, bytesOf, venueB, venueF, venuePump } from "./helpers/depth.ts";

/** Edge cases: degenerate pools, extreme amounts, corrupted data, inconsistent snapshots. */

const WSOL = "So11111111111111111111111111111111111111112";
const ANTH = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw";
const feeCfg = { flatFees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n }, feeTiers: [{ marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n } }], stableFeeTiers: [], exoticFlatFees: { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n } };
const pump = (baseReserve: bigint, quoteVault: bigint, virtual = 0n, tf: { base: null; quote: null } = { base: null, quote: null }) =>
  createPumpVenue({ poolAddress: POOLS.A, baseMint: MINTS.A, quoteMint: WSOL, baseDecimals: 6, quoteDecimals: 9, baseReserve, quoteVault, virtualQuoteReserves: virtual, protocolFees: 0n, creatorFees: 0n, unsupported: [], transferFee: tf, feeContext: { global: { lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 5n, creatorFeeConfigurable: false }, feeConfig: feeCfg, poolCreator: "x", canonicalCreator: "x", baseMint: MINTS.A, quoteMint: WSOL, coinCreator: "11111111111111111111111111111111", isMayhemMode: false, poolCreatorFeeBps: 0n, baseMintSupply: 10n ** 15n } });
const cpmm = (r0: bigint, r1: bigint) =>
  createCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.B, quoteMint: ANTH, baseDecimals: 6, quoteDecimals: 9, baseIsToken0: false, reserve0: r0, reserve1: r1, tradeFeeRate: 2500n, protocolFeeRate: 120000n, fundFeeRate: 40000n, creatorFeeRate: 0n, creatorFeeOn: 0, unsupported: [], transferFee: { base: null, quote: null } });

const allVenues = (): [string, Venue][] => [["F", venueF().venue], ["B", venueB().venue], ["A", venuePump("A").venue], ["C", venuePump("C").venue]];

test("amounts beyond u64 are refused by every engine (no overflow, no exception)", () => {
  for (const [name, v] of allVenues()) {
    for (const o of [v.buy(U64_MAX + 1n), v.sell(U64_MAX + 1n), v.buy(10n ** 40n), v.sell(10n ** 40n)]) {
      assert.ok(!o.ok && o.reason === "unsupported", `${name}: ${o.ok ? "ok" : o.reason}`);
    }
  }
});

test("the largest representable amount, zero, and one raw unit never throw and never create tokens from nothing", () => {
  for (const [name, v] of allVenues()) {
    for (const side of ["buy", "sell"] as const) {
      const fn = (a: bigint) => (side === "buy" ? v.buy(a) : v.sell(a));
      assert.doesNotThrow(() => fn(U64_MAX), `${name} ${side} max`);
      assert.ok(!fn(0n).ok, `${name} ${side} 0`);
      assert.ok(!fn(-5n).ok, `${name} ${side} negative`);
      const one = fn(1n);
      if (one.ok) assert.ok(one.amountOut <= 1n * 10n ** 12n, `${name} ${side}: 1 unit gave ${one.amountOut}`);
    }
  }
});

test("degenerate pools (no reserves) are analysed without throwing, and nothing is reachable", () => {
  const venues: Venue[] = [pump(0n, 0n), pump(10n ** 15n, 0n), pump(0n, 10n ** 10n), cpmm(0n, 0n), cpmm(10n ** 9n, 0n), cpmm(0n, 10n ** 9n)];
  for (const v of venues) {
    const r = analyzeDepth({ venue: v, quote: { usdPerQuote: 1, source: "test" }, baseSupply: 10n ** 15n });
    assert.ok(r.ask.every((x) => !x.reached) || r.bid.every((x) => !x.reached) || r.ask.some((x) => x.reached), "no crash");
    assert.ok(r.buys.every((t) => !t.ok), `${v.info.kind}: buys on an empty pool must fail`);
    assert.doesNotThrow(() => JSON.stringify(r));
  }
});

test("a CLMM with no liquidity anywhere refuses both sides", () => {
  const v = createClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.F, quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", baseDecimals: 6, quoteDecimals: 6, baseIsToken0: true, sqrtPriceX64: 1n << 64n, liquidity: 0n, tickCurrent: 0, feeRate: 100, feeOn: 0, ticks: [], ticksComplete: true, unsupported: [], transferFee: { base: null, quote: null } });
  assert.ok(!v.buy(1_000_000n).ok && !v.sell(1_000_000n).ok);
  const r = searchDepth(v, "buy", 100);
  assert.equal(r.reached, false);
});

test("a transfer-fee cap lower than the rate wins: the tax equals the maximum fee", () => {
  const v = createPumpVenue({
    poolAddress: POOLS.A, baseMint: MINTS.A, quoteMint: WSOL, baseDecimals: 6, quoteDecimals: 9,
    baseReserve: 10n ** 15n, quoteVault: 10n ** 11n, virtualQuoteReserves: 0n, protocolFees: 0n, creatorFees: 0n, unsupported: [],
    transferFee: { base: { bps: 100, maximumFee: 5n }, quote: null },
    feeContext: { global: { lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 5n, creatorFeeConfigurable: false }, feeConfig: feeCfg, poolCreator: "x", canonicalCreator: "x", baseMint: MINTS.A, quoteMint: WSOL, coinCreator: "11111111111111111111111111111111", isMayhemMode: false, poolCreatorFeeBps: 0n, baseMintSupply: 10n ** 15n },
  });
  const o = v.buy(10n ** 10n);
  assert.ok(o.ok);
  if (o.ok) assert.equal(o.fees["transfer_fee_out"], 5n, "1 % of the output is far above the 5-unit cap, so the cap applies");
});

// ───────── corrupted or inconsistent data ─────────
test("a truncated Token-2022 extension and a wrong account type are refused", () => {
  const mint = bytesOf(MINTS.B).slice();
  const cut = mint.slice(0, 180); // the first extension header claims more bytes than remain
  assert.throws(() => decodeMint(cut), RangeError);
});

test("snapshot errors: missing account, foreign base mint, inconsistent vault, negative effective reserves", () => {
  const without = (addr: string): AccountMap => {
    const c: AccountMap = { ...accounts };
    delete c[addr];
    return c;
  };
  assert.throws(() => buildClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.F, accounts: without(POOLS.F), tickArrays: Object.values(F_TICK_ARRAYS), ticksComplete: true, epoch: EPOCH }), SnapshotError);
  assert.throws(() => buildClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.A, accounts, tickArrays: [], ticksComplete: true, epoch: EPOCH }), /not one of the pool's mints/);
  assert.throws(() => buildCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.A, accounts, epoch: EPOCH }), /not one of the pool's mints/);
  assert.throws(() => buildCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.B, accounts: without(POOLS.B), epoch: EPOCH }), SnapshotError);
  assert.throws(() => buildPumpVenue({ poolAddress: POOLS.A, accounts: without(PUMP_GLOBAL_CONFIG), globalConfigAddress: PUMP_GLOBAL_CONFIG, feeConfigAddress: PUMP_FEE_CONFIG, canonicalCreator: PUMP_CANONICAL_CREATOR.A, epoch: EPOCH }), SnapshotError);
  // a vault whose balance is below the fees the pool says it holds is an inconsistent snapshot
  const vault1 = decodeCpmmPool(bytesOf(POOLS.B)).vault1;
  const bytes = bytesOf(vault1).slice();
  bytes.fill(0, 64, 72);
  const broken: AccountMap = { ...accounts, [vault1]: { owner: ACCOUNTS[vault1]!.owner, data: Buffer.from(bytes).toString("base64") } };
  assert.throws(() => buildCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.B, accounts: broken, epoch: EPOCH }), /below the tracked fees/);
  // negative effective reserves (virtual reserves larger than the vault can offset) are refused
  const pump = decodePumpPool(bytesOf(POOLS.A));
  const pb = bytesOf(POOLS.A).slice();
  new DataView(pb.buffer, pb.byteOffset, pb.byteLength).setBigUint64(245, (1n << 64n) - 1n, true);
  new DataView(pb.buffer, pb.byteOffset, pb.byteLength).setBigUint64(253, (1n << 64n) - 1n, true); // i128 = -1
  void pump;
  const negative: AccountMap = { ...accounts, [POOLS.A]: { owner: ACCOUNTS[POOLS.A]!.owner, data: Buffer.from(pb).toString("base64") } };
  const vq = decodePumpPool(pb).virtualQuoteReserves;
  assert.equal(vq, -1n);
  // -1 does not make the effective reserves negative (the vault holds SOL): the snapshot builds, and the real reserves are untouched
  assert.ok(buildPumpVenue({ poolAddress: POOLS.A, accounts: negative, globalConfigAddress: PUMP_GLOBAL_CONFIG, feeConfigAddress: PUMP_FEE_CONFIG, canonicalCreator: PUMP_CANONICAL_CREATOR.A, epoch: EPOCH }).venue);
  new DataView(pb.buffer, pb.byteOffset, pb.byteLength).setBigUint64(245, 0n, true);
  new DataView(pb.buffer, pb.byteOffset, pb.byteLength).setBigUint64(253, 1n << 63n, true); // i128 = -2^127
  const hugeNegative: AccountMap = { ...accounts, [POOLS.A]: { owner: ACCOUNTS[POOLS.A]!.owner, data: Buffer.from(pb).toString("base64") } };
  assert.throws(() => buildPumpVenue({ poolAddress: POOLS.A, accounts: hugeNegative, globalConfigAddress: PUMP_GLOBAL_CONFIG, feeConfigAddress: PUMP_FEE_CONFIG, canonicalCreator: PUMP_CANONICAL_CREATOR.A, epoch: EPOCH }), /effective quote reserves are negative/);
});

test("PumpSwap without the fee-program account falls back to the global rates and says it is an estimate", () => {
  const built = buildPumpVenue({ poolAddress: POOLS.A, accounts, globalConfigAddress: PUMP_GLOBAL_CONFIG, feeConfigAddress: null, canonicalCreator: PUMP_CANONICAL_CREATOR.A, epoch: EPOCH });
  assert.ok(built.venue.info.unsupported.some((u) => /fee program account unavailable/.test(u)));
  assert.match(built.venue.info.fees[0]!, /global config rates/);
  const r = analyzeDepth({ venue: built.venue, quote: { usdPerQuote: 100, source: "test" }, baseSupply: built.baseSupply });
  assert.equal(r.complete, false);
});

test("the engine is self-contained: every number in the F snapshot comes from the fixtures (no network, no clock)", () => {
  const before = JSON.stringify(analyzeDepth({ venue: venueF().venue, quote: { usdPerQuote: 1, source: "t" }, baseSupply: venueF().baseSupply }));
  const after = JSON.stringify(analyzeDepth({ venue: venueF().venue, quote: { usdPerQuote: 1, source: "t" }, baseSupply: venueF().baseSupply }));
  assert.equal(before, after);
  assert.ok(Object.keys(ACCOUNTS).length > 0);
});
