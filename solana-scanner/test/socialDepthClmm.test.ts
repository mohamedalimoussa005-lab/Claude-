import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSwapStepExactIn, createClmmVenue, getSqrtPriceAtTick, isFeeOnInput } from "../src/social/depth/clmm.ts";
import type { ClmmVenueParams } from "../src/social/depth/clmm.ts";
import { maxFeasible } from "../src/social/depth/engine.ts";
import { buildClmmVenue } from "../src/social/depth/snapshot.ts";
import type { AccountMap } from "../src/social/depth/snapshot.ts";
import type { SwapFill, Venue } from "../src/social/depth/types.ts";
import { ACCOUNTS, DEX_PRICES, EPOCH, F_TICK_ARRAYS, MINTS, POOLS } from "./fixtures/social/depth/raw.ts";
import { accounts, bytesOf, prng, randLog, venueF } from "./helpers/depth.ts";

/** Raydium CLMM engine: closed forms, tick crossing, liquidity limits, rounding, properties, and a real swap. */

const Q64 = 1n << 64n;
const BASE = "So11111111111111111111111111111111111111112"; // arbitrary valid mints for synthetic pools
const QUOTE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function pool(over: Partial<ClmmVenueParams> & { ticks: ClmmVenueParams["ticks"] }): Venue {
  return createClmmVenue({
    poolAddress: "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj",
    baseMint: BASE,
    quoteMint: QUOTE,
    baseDecimals: 6,
    quoteDecimals: 6,
    baseIsToken0: true,
    sqrtPriceX64: Q64,
    liquidity: 0n,
    tickCurrent: 0,
    feeRate: 2500,
    feeOn: 0,
    ticksComplete: true,
    unsupported: [],
    transferFee: { base: null, quote: null },
    ...over,
  });
}
const L = 10n ** 15n;
/** One position [-1000, 1000] around tick 0. */
const single = (over: Partial<ClmmVenueParams> = {}) =>
  pool({ liquidity: L, ticks: [{ tick: -1000, liquidityNet: L }, { tick: 1000, liquidityNet: -L }], ...over });

const fill = (o: ReturnType<Venue["buy"]>): SwapFill => {
  assert.ok(o.ok, o.ok ? "" : `${o.reason}: ${o.detail}`);
  return o as SwapFill;
};
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

// ───────── closed forms (independent float implementation of the same maths) ─────────
test("single range, buy (price rises): matches the closed form Δx = L(1/√P0 − 1/√P1) with √P1 = √P0 + net/L", () => {
  const y = 5_000_000_000n; // 5 000 quote units
  const net = Number(y) * (1 - 0.0025);
  const sqrt0 = 1;
  const sqrt1 = sqrt0 + net / Number(L);
  const expected = Number(L) * (1 / sqrt0 - 1 / sqrt1);
  const o = fill(single().buy(y));
  assert.ok(rel(Number(o.amountOut), expected) < 1e-9, `${o.amountOut} vs ${expected}`);
  assert.equal(o.amountIn, y);
});

test("single range, sell (price falls): matches the closed form Δy = L(√P0 − √P1) with √P1 = L / (L/√P0 + net)", () => {
  const x = 4_000_000_000n;
  const net = Number(x) * (1 - 0.0025);
  const sqrt1 = Number(L) / (Number(L) / 1 + net);
  const expected = Number(L) * (1 - sqrt1);
  const o = fill(single().sell(x));
  assert.ok(rel(Number(o.amountOut), expected) < 1e-9, `${o.amountOut} vs ${expected}`);
});

test("the fee is charged on the input: input = used + fee, and the fee is the pool rate (ceil/floor as the program)", () => {
  const o = fill(single().buy(1_000_000_000n));
  const fee = o.fees["trade_fee_quote"]!;
  // partial step: the fee is whatever is left after the amount that moved the price
  assert.ok(fee >= (1_000_000_000n * 2500n) / 1_000_000n && fee <= (1_000_000_000n * 2500n) / 1_000_000n + 2n, `fee ${fee}`);
});

test("fee on the OUTPUT (pool.fee_on = 1, token0 only): the whole input moves the price, the output loses the fee", () => {
  const y = 5_000_000_000n;
  const sqrt1 = 1 + Number(y) / Number(L);
  const gross = Number(L) * (1 / 1 - 1 / sqrt1);
  const expected = gross * (1 - 0.0025); // fee ceil on the gross output
  const o = fill(single({ feeOn: 1 }).buy(y));
  assert.ok(rel(Number(o.amountOut), expected) < 1e-9, `${o.amountOut} vs ${expected}`);
  // base = token0 and fee_on = token0-only → selling (zero_for_one) keeps the fee on the input
  assert.equal(isFeeOnInput(1, true), true);
  assert.equal(isFeeOnInput(1, false), false);
  assert.equal(isFeeOnInput(2, true), false);
  assert.equal(isFeeOnInput(0, false), true);
});

// ───────── tick crossing, liquidity changes, limits ─────────
test("crossing an initialized tick changes the active liquidity (two adjacent positions)", () => {
  const L2 = 4n * 10n ** 14n;
  const v = pool({
    liquidity: L,
    ticks: [{ tick: -1000, liquidityNet: L }, { tick: 1000, liquidityNet: -L + L2 }, { tick: 2000, liquidityNet: -L2 }],
  });
  const s1000 = Number(getSqrtPriceAtTick(1000)) / 2 ** 64;
  const y = 70_000_000_000_000n; // 7e13: more than the ~5.1e13 needed to reach tick 1000
  const net = Number(y) * (1 - 0.0025);
  const toTick = Number(L) * (s1000 - 1); // quote needed to reach tick 1000 with L
  assert.ok(net > toTick, "the order must cross the tick");
  const rest = net - toTick;
  const s2 = s1000 + rest / Number(L2);
  const expected = Number(L) * (1 / 1 - 1 / s1000) + Number(L2) * (1 / s1000 - 1 / s2);
  const o = fill(v.buy(y));
  assert.ok(rel(Number(o.amountOut), expected) < 1e-6, `${o.amountOut} vs ${expected}`);
});

test("a gap with zero liquidity between two positions is crossed at no cost", () => {
  const v = pool({ liquidity: L, ticks: [{ tick: -1000, liquidityNet: L }, { tick: 0, liquidityNet: -L }, { tick: 500, liquidityNet: L }, { tick: 1000, liquidityNet: -L }], tickCurrent: -1, sqrtPriceX64: getSqrtPriceAtTick(-1) + 5n });
  const o = fill(v.buy(400_000_000_000n)); // 4e11 > the ~5e10 needed to reach tick 0
  assert.ok(o.amountOut > 0n);
  // The same order against only the second position, starting at its lower edge, gives the same output for what is left after tick 0.
  const after = o.next.spot();
  assert.ok(after.num * 1n > 0n);
  const s500 = getSqrtPriceAtTick(500);
  assert.ok(o.next.spot().num * (1n << 128n) >= s500 * s500 * o.next.spot().den - 1n, "the price ended at or above the second position's lower edge");
});

test("liquidity exhausted: a buy larger than all liquidity fails, reporting how much was available", () => {
  const v = single();
  const big = 10n ** 18n;
  const o = v.buy(big);
  assert.equal(o.ok, false);
  assert.ok(!o.ok && o.reason === "liquidity_exhausted");
  const cap = maxFeasible(v, "buy", big);
  assert.ok(cap.fill && cap.fill.amountIn < big && cap.fill.amountIn > 0n);
  // just above the capacity fails, the capacity itself works
  assert.ok(v.buy(cap.amount).ok);
  assert.ok(!v.buy(cap.amount + cap.amount / 100n + 10n).ok);
});

test("tick data not fully loaded: running past the loaded ticks is 'beyond_loaded_data', not 'no liquidity'", () => {
  const o = single({ ticksComplete: false }).buy(10n ** 18n);
  assert.ok(!o.ok && o.reason === "beyond_loaded_data");
});

test("a pool whose current tick has no liquidity ahead in the direction of the trade refuses cleanly", () => {
  const v = pool({ liquidity: 0n, ticks: [{ tick: -1000, liquidityNet: L }, { tick: -500, liquidityNet: -L }], tickCurrent: 0, sqrtPriceX64: Q64 });
  const o = v.buy(1_000_000n);
  assert.ok(!o.ok && o.reason === "liquidity_exhausted");
});

test("rounding: sub-unit orders produce nothing (never a free token), and the output is rounded down", () => {
  const v = single();
  const o = v.buy(1n);
  assert.ok(!o.ok, "1 raw unit cannot buy anything");
  for (let y = 1n; y < 2000n; y += 37n) {
    const r = v.buy(y);
    if (r.ok) assert.ok(r.amountOut <= (y * 10n ** 6n) / 1n, "sanity bound");
  }
});

test("computeSwapStep: reaching the target charges ceil(in × fee / (1 − fee)); stopping short spends everything", () => {
  const sqrt0 = Q64;
  const target = getSqrtPriceAtTick(100);
  // enough input to reach the target
  const reach = computeSwapStepExactIn(sqrt0, target, L, 10n ** 14n, 2500n, false, true); // 1e14 ≫ the ~5e12 needed to climb 100 ticks
  assert.equal(reach.sqrtNext, target);
  assert.equal(reach.fee, (reach.amountIn * 2500n + (1_000_000n - 2500n) - 1n) / (1_000_000n - 2500n));
  // little input: stops short and charges the remainder as fee
  const short = computeSwapStepExactIn(sqrt0, target, L, 1_000_000n, 2500n, false, true);
  assert.ok(short.sqrtNext < target);
  assert.equal(short.amountIn + short.fee, 1_000_000n);
  // fee on output, stopping short: the whole input is charged, the fee comes out of the output
  const outShort = computeSwapStepExactIn(sqrt0, target, L, 1_000_000n, 2500n, false, false);
  assert.equal(outShort.amountIn, 1_000_000n);
  assert.ok(outShort.fee > 0n);
});

// ───────── properties (deterministic PRNG) ─────────
function randomPool(rng: () => number): Venue {
  const nPos = 1 + Math.floor(rng() * 3);
  const ticks = new Map<number, bigint>();
  let start = -2000 + Math.floor(rng() * 1500);
  let active = 0n;
  for (let i = 0; i < nPos; i++) {
    const lo = start + Math.floor(rng() * 400);
    const hi = lo + 200 + Math.floor(rng() * 1500);
    const liq = randLog(rng, 10n ** 12n, 10n ** 16n);
    ticks.set(lo, (ticks.get(lo) ?? 0n) + liq);
    ticks.set(hi, (ticks.get(hi) ?? 0n) - liq);
    start = lo + 100;
  }
  const sorted = [...ticks.entries()].sort((a, b) => a[0] - b[0]);
  const lowest = sorted[0]![0];
  const cur = lowest + 50 + Math.floor(rng() * 150);
  for (const [t, net] of sorted) if (t <= cur) active += net;
  return pool({ liquidity: active, tickCurrent: cur, sqrtPriceX64: getSqrtPriceAtTick(cur) + BigInt(Math.floor(rng() * 1000)), feeRate: [100, 500, 2500, 10000][Math.floor(rng() * 4)]!, feeOn: [0, 0, 1, 2][Math.floor(rng() * 4)]!, ticks: sorted.map(([tick, liquidityNet]) => ({ tick, liquidityNet })) });
}

test("property: more input never gives less output; the spot price moves the right way; the user never receives more than the pool's liquidity allows", () => {
  const rng = prng(1234);
  let checked = 0;
  for (let i = 0; i < 150; i++) {
    const v = randomPool(rng);
    for (const side of ["buy", "sell"] as const) {
      const a = randLog(rng, 10n ** 3n, 10n ** 9n);
      const b = a + randLog(rng, 1n, 10n ** 9n);
      const oa = side === "buy" ? v.buy(a) : v.sell(a);
      const ob = side === "buy" ? v.buy(b) : v.sell(b);
      if (oa.ok) {
        assert.ok(oa.amountOut > 0n && oa.amountIn === a);
        const before = v.spot();
        const after = oa.next.spot();
        if (side === "buy") assert.ok(after.num * before.den >= before.num * after.den, "buy lowers the price");
        else assert.ok(after.num * before.den <= before.num * after.den, "sell raises the price");
      }
      if (oa.ok && ob.ok) {
        assert.ok(ob.amountOut >= oa.amountOut, `monotonic ${side}: ${oa.amountOut} -> ${ob.amountOut}`);
        checked++;
      }
      // if the larger order fits, the smaller one fits
      if (ob.ok && !oa.ok) assert.ok(oa.reason === "amount_too_small", `smaller order failed for a reason other than size: ${oa.ok ? "" : oa.reason}`);
    }
  }
  assert.ok(checked > 100, `only ${checked} comparisons ran`);
});

test("property: an immediate round trip never returns more than was paid (fees make it strictly lossy)", () => {
  const rng = prng(99);
  let trips = 0;
  for (let i = 0; i < 200; i++) {
    const v = randomPool(rng);
    const y = randLog(rng, 10n ** 6n, 10n ** 10n);
    const b = v.buy(y);
    if (!b.ok) continue;
    const s = b.next.sell(b.amountOut);
    if (!s.ok) continue;
    assert.ok(s.amountOut < y, `round trip gained: paid ${y}, got back ${s.amountOut}`);
    trips++;
  }
  assert.ok(trips > 80, `only ${trips} round trips ran`);
});

// ───────── F: the real pool ─────────
test("F: the simulated swap reproduces a real on-chain swap (10 010 USDC → 293 436.578153 AI) to < 1e-8", () => {
  const F = venueF().venue;
  const o = fill(F.buy(10_010_000_000n));
  const actual = 293_436_578_153n; // tx 5ycDHE21…, slot 454933180
  assert.ok(Math.abs(Number(o.amountOut - actual)) / Number(actual) < 1e-8, `${o.amountOut} vs ${actual}`);
  const small = fill(F.buy(156_400n));
  assert.equal(small.amountOut, 4_585_000n, "the 0.1564 USDC swap of 18:08:14 gives 4.585000 AI");
});

test("F: spot price equals the DEX price, and the pool agrees with itself at the current tick", () => {
  const { venue } = venueF();
  const s = venue.spot();
  const price = Number(s.num * 10n ** 30n / s.den) / 1e30;
  assert.ok(rel(price, Number(DEX_PRICES["F"]!.priceUsd)) < 1e-3, `${price} vs ${DEX_PRICES["F"]!.priceUsd}`);
});

test("F: buying has deep liquidity (a single range up to +49.96 %), selling has almost none", () => {
  const { venue } = venueF();
  // buy side: $1 M moves the price by about 1 %
  const ask = fill(venue.buy(1_000_000_000_000n));
  const before = venue.spot();
  const after = ask.next.spot();
  const moved = Number((after.num * before.den * 10_000n) / (after.den * before.num)) / 10_000 - 1;
  assert.ok(moved > 0.009 && moved < 0.012, `a $1M buy should move the price ~1 %, got ${moved}`);
  // sell side: the only liquidity below the price is the part of the position between the price and its lower tick
  const cap = maxFeasible(venue, "sell", 10n ** 15n);
  assert.ok(cap.fill);
  assert.ok(cap.fill!.amountOut <= 918_036n && cap.fill!.amountOut >= 918_034n, `exit capacity ${cap.fill!.amountOut} should equal the position's USDC (918 036)`);
  assert.ok(!venue.sell(cap.amount + 10n ** 6n).ok);
});

test("F: the exit capacity is NOT the USDC balance of the pool (that balance is mostly accrued fees)", () => {
  const { venue, observed } = venueF();
  const cap = maxFeasible(venue, "sell", 10n ** 15n);
  assert.ok(observed["liquidity"]);
  // 22.7 USDC sit in the vault, but only ~0.92 can be bought back
  assert.ok(cap.fill!.amountOut < 1_000_000n);
});

test("F: an immediate round trip works (the buyer's own USDC becomes bid liquidity), but tokens that already exist cannot exit", () => {
  const { venue } = venueF();
  // Immediate round trip of $1 000: only the two 0.01 % fees (and a hair of price movement) are lost.
  const b = fill(venue.buy(1_000_000_000n));
  const s = b.next.sell(b.amountOut);
  assert.ok(s.ok);
  if (s.ok) {
    assert.ok(s.amountOut < 1_000_000_000n);
    assert.ok(s.amountOut >= 999_700_000n && s.amountOut <= 999_800_020n /* 1000 × (1 − 0.0001)² = 999.80001 */, `got back ${s.amountOut} of 1 000 000 000`);
  }
  // A holder who bought earlier is in a different position: the pool's own bid liquidity is ~$0.92 only.
  const existing = venue.sell(b.amountOut);
  assert.ok(!existing.ok && existing.reason === "liquidity_exhausted");
});

// ───────── unsupported features are detected, never silently simulated ─────────
function withMutatedPool(mutate: (pool: Uint8Array) => void): AccountMap {
  const copy: AccountMap = { ...accounts };
  const bytes = bytesOf(POOLS.F).slice();
  mutate(bytes);
  copy[POOLS.F] = { owner: ACCOUNTS[POOLS.F]!.owner, data: Buffer.from(bytes).toString("base64") };
  return copy;
}
const buildF = (acc: AccountMap, arrays = Object.values(F_TICK_ARRAYS)) => buildClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.F, accounts: acc, tickArrays: arrays, ticksComplete: true, epoch: EPOCH });

test("unsupported: dynamic fees configured on the pool make every result an estimate", () => {
  const b = buildF(withMutatedPool((p) => (p[1096 + 20] = 1)));
  assert.ok(b.venue.info.unsupported.some((u) => /dynamic fee/.test(u)));
  assert.equal(buildF(accounts).venue.info.unsupported.length, 0);
});

test("unsupported: swaps disabled in the pool status, and limit orders on a tick", () => {
  const disabled = buildF(withMutatedPool((p) => (p[389] = 16)));
  assert.ok(disabled.venue.info.unsupported.some((u) => /disabled/.test(u)));
  const arrays = Object.values(F_TICK_ARRAYS).map((b64) => {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    for (let i = 0; i < 60; i++) {
      const o = 44 + 168 * i;
      if (bytes[o + 20] !== 0 || bytes[o + 21] !== 0) bytes[o + 124] = 7; // orders_amount ≠ 0 on the initialized tick
    }
    return Buffer.from(bytes).toString("base64");
  });
  const withOrders = buildF(accounts, arrays);
  assert.ok(withOrders.venue.info.unsupported.some((u) => /limit orders/.test(u)));
});

test("a tick array that belongs to another pool is refused", () => {
  const wrong = Object.values(F_TICK_ARRAYS).map((b64) => {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    bytes[8] ^= 0xff;
    return Buffer.from(bytes).toString("base64");
  });
  assert.throws(() => buildF(accounts, wrong), /another pool/);
});
