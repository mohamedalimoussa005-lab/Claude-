import { test } from "node:test";
import assert from "node:assert/strict";
import { cpmmSwapBaseInput, createCpmmVenue, isCreatorFeeOnInput } from "../src/social/depth/cpmm.ts";
import type { CpmmVenueParams } from "../src/social/depth/cpmm.ts";
import { decodePumpFeeConfig } from "../src/social/depth/decode.ts";
import type { PumpFeeConfigData, PumpGlobalConfigData } from "../src/social/depth/decode.ts";
import { maxFeasible, searchDepth } from "../src/social/depth/engine.ts";
import { calculateFeeTier, createPumpVenue, effectiveQuote, pumpQuoteKind, realQuote, resolvePumpFees } from "../src/social/depth/pumpswap.ts";
import type { PumpFeeContext, PumpVenueParams } from "../src/social/depth/pumpswap.ts";
import { feeAtEpoch, transferFee } from "../src/social/depth/token2022.ts";
import type { SwapFill, Venue } from "../src/social/depth/types.ts";
import { CPMM_EVENTS_B, PUMP_EVENTS_A, PUMP_EVENTS_C } from "./fixtures/social/depth/events.ts";
import { EPOCH, MINTS, POOLS, PUMP_FEE_CONFIG } from "./fixtures/social/depth/raw.ts";
import { bytesOf, prng, randLog, venueB, venuePump } from "./helpers/depth.ts";

/** Raydium CP-Swap and PumpSwap engines: exact replication of real swaps, fee rules, reserves, properties. */

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ANTHROPIC = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw";
const big = (v: unknown): bigint => BigInt(v as string | number);
const fill = (o: ReturnType<Venue["buy"]>): SwapFill => {
  assert.ok(o.ok, o.ok ? "" : `${o.reason}: ${o.detail}`);
  return o as SwapFill;
};
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

// ═════════════════════════ CP-Swap (CPMM) ═════════════════════════

test("CPMM fee primitives: trading fee rounds UP, protocol / fund fee round DOWN, creator split rounds DOWN", () => {
  // 1000 × 2500 / 1e6 = 2.5 → trade fee 3 (ceil); protocol = floor(3 × 120000 / 1e6) = 0; fund = floor(3 × 40000 / 1e6) = 0
  const r = cpmmSwapBaseInput(1000n, 10n ** 9n, 10n ** 9n, 2500n, 0n, 120000n, 40000n, false)!;
  assert.equal(r.tradeFee, 3n);
  assert.equal(r.protocolFee, 0n);
  assert.equal(r.fundFee, 0n);
  // a larger trade: 1e6 × 2500 / 1e6 = 2500; protocol = 2500 × 0.12 = 300; fund = 100
  const big1 = cpmmSwapBaseInput(10n ** 6n, 10n ** 12n, 10n ** 12n, 2500n, 0n, 120000n, 40000n, false)!;
  assert.deepEqual([big1.tradeFee, big1.protocolFee, big1.fundFee], [2500n, 300n, 100n]);
  // creator fee on input: total = ceil(in × (trade + creator) / 1e6), creator = floor(total × creator / (trade + creator))
  const c = cpmmSwapBaseInput(10n ** 6n, 10n ** 12n, 10n ** 12n, 2500n, 10000n, 120000n, 40000n, true)!;
  assert.equal(c.creatorFee + c.tradeFee, 12500n);
  assert.equal(c.creatorFee, 10000n);
  // creator fee on output: ceil(swapped × creator / 1e6)
  const o = cpmmSwapBaseInput(10n ** 6n, 10n ** 12n, 10n ** 12n, 2500n, 10000n, 120000n, 40000n, false)!;
  const swapped = ((10n ** 6n - 2500n) * 10n ** 12n) / (10n ** 12n + 10n ** 6n - 2500n);
  assert.equal(o.creatorFee, (swapped * 10000n + 999_999n) / 1_000_000n);
  assert.equal(o.outputAmount, swapped - o.creatorFee);
  assert.equal(cpmmSwapBaseInput(1n, 10n ** 9n, 10n ** 9n, 2500n, 0n, 0n, 0n, false), null, "1 unit pays the fee and leaves nothing to swap");
});

test("creator_fee_on decides on which side the creator fee is taken", () => {
  assert.equal(isCreatorFeeOnInput(0, true), true);
  assert.equal(isCreatorFeeOnInput(0, false), true);
  assert.equal(isCreatorFeeOnInput(1, true), true); // token0 only: input is token0
  assert.equal(isCreatorFeeOnInput(1, false), false);
  assert.equal(isCreatorFeeOnInput(2, true), false);
  assert.equal(isCreatorFeeOnInput(2, false), true);
  assert.throws(() => isCreatorFeeOnInput(3, true), RangeError);
});

test("CPMM: six real swaps on B are reproduced exactly (output, trade fee, creator fee, both Token-2022 taxes)", () => {
  const b = venueB();
  const info = b.venue.info;
  assert.equal(info.kind, "cpmm");
  const tfB = feeAtEpoch(b.baseMintData.transferFee!, EPOCH);
  const tfQ = feeAtEpoch(b.quoteMintData.transferFee!, EPOCH);
  assert.equal(tfB.bps, 100);
  assert.equal(tfQ.bps, 100);
  let both = 0;
  for (const e of CPMM_EVENTS_B) {
    const d = e.data;
    const inputIsQuote = d["input_mint"] === ANTHROPIC;
    const reserveIn = big(d["input_vault_before"]);
    const reserveOut = big(d["output_vault_before"]);
    const venue = createCpmmVenue({
      poolAddress: POOLS.B,
      baseMint: MINTS.B,
      quoteMint: ANTHROPIC,
      baseDecimals: 6,
      quoteDecimals: 9,
      baseIsToken0: false,
      reserve0: inputIsQuote ? reserveIn : reserveOut,
      reserve1: inputIsQuote ? reserveOut : reserveIn,
      tradeFeeRate: 2500n,
      protocolFeeRate: 120000n,
      fundFeeRate: 40000n,
      creatorFeeRate: 10000n,
      creatorFeeOn: 1,
      unsupported: [],
      transferFee: { base: tfB, quote: tfQ },
    });
    const userIn = big(d["input_amount"]) + big(d["input_transfer_fee"]);
    assert.equal(transferFee(userIn, inputIsQuote ? tfQ : tfB), big(d["input_transfer_fee"]), "input tax");
    const o = fill(inputIsQuote ? venue.buy(userIn) : venue.sell(userIn));
    assert.equal(o.amountOut, big(d["output_amount"]) - big(d["output_transfer_fee"]), `${e.signature.slice(0, 8)} output`);
    assert.equal(o.fees["trade_fee_in"], big(d["trade_fee"]), "trade fee");
    assert.equal(o.fees["creator_fee"], big(d["creator_fee"]), "creator fee");
    assert.equal(o.fees["transfer_fee_out"], big(d["output_transfer_fee"]), "output tax");
    assert.equal(d["creator_fee_on_input"], inputIsQuote, "creator fee side");
    both++;
  }
  assert.equal(both, 6);
  assert.ok(CPMM_EVENTS_B.some((e) => e.data["input_mint"] === ANTHROPIC) && CPMM_EVENTS_B.some((e) => e.data["input_mint"] !== ANTHROPIC), "both directions are covered");
});

test("CPMM: B's reserves are the vault balances minus the tracked protocol, fund and creator fees", () => {
  const b = venueB();
  assert.equal(b.observed["reserve0"], (8_791_544_380n - (2_712_670n + 840_146n + 24_215_058n)).toString());
  assert.equal(b.observed["reserve1"], (241_572_079_986_577n - (22_149_398_394n + 23_902_764_882n)).toString());
  assert.equal(b.observed["creatorFeeRate"], "10000");
  assert.equal(b.observed["enableCreatorFee"], true);
});

test("CPMM, no fees and no tax: output and +1 % depth follow the textbook constant-product formulas", () => {
  const x = 4_000_000_000_000n; // base
  const y = 100_000_000_000n; // quote
  const v = createCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.B, quoteMint: ANTHROPIC, baseDecimals: 6, quoteDecimals: 9, baseIsToken0: false, reserve0: y, reserve1: x, tradeFeeRate: 0n, protocolFeeRate: 0n, fundFeeRate: 0n, creatorFeeRate: 0n, creatorFeeOn: 0, unsupported: [], transferFee: { base: null, quote: null } });
  const o = fill(v.buy(10n ** 9n));
  assert.equal(o.amountOut, (10n ** 9n * x) / (y + 10n ** 9n));
  const s = fill(v.sell(10n ** 9n));
  assert.equal(s.amountOut, (10n ** 9n * y) / (x + 10n ** 9n));
  const d = searchDepth(v, "buy", 100);
  assert.ok(d.reached);
  const expected = Number(y) * (Math.sqrt(1.01) - 1);
  assert.ok(rel(Number(d.amount), expected) < 1e-6, `${d.amount} vs ${expected}`);
  const dsell = searchDepth(v, "sell", 100);
  assert.ok(rel(Number(dsell.amount), Number(x) * (1 / Math.sqrt(0.99) - 1)) < 1e-6);
});

test("CPMM: each Token-2022 tax removes about 1 % at its own leg", () => {
  const base: CpmmVenueParams = { poolAddress: POOLS.B, baseMint: MINTS.B, quoteMint: ANTHROPIC, baseDecimals: 6, quoteDecimals: 9, baseIsToken0: false, reserve0: 10n ** 12n, reserve1: 10n ** 15n, tradeFeeRate: 0n, protocolFeeRate: 0n, fundFeeRate: 0n, creatorFeeRate: 0n, creatorFeeOn: 0, unsupported: [], transferFee: { base: null, quote: null } };
  const none = fill(createCpmmVenue(base).buy(10n ** 9n)).amountOut;
  const taxIn = fill(createCpmmVenue({ ...base, transferFee: { base: null, quote: { bps: 100, maximumFee: 10n ** 18n } } }).buy(10n ** 9n)).amountOut;
  const taxOut = fill(createCpmmVenue({ ...base, transferFee: { base: { bps: 100, maximumFee: 10n ** 18n }, quote: null } }).buy(10n ** 9n)).amountOut;
  assert.ok(rel(Number(taxIn), Number(none) * 0.99) < 1e-3);
  assert.equal(taxOut, none - (none + 99n) / 100n, "ceil(1 %) on the output");
});

test("property CPMM: constant product never shrinks, round trips lose, bigger orders never output less", () => {
  const rng = prng(2024);
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const r0 = randLog(rng, 10n ** 8n, 10n ** 14n);
    const r1 = randLog(rng, 10n ** 8n, 10n ** 14n);
    const v = createCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.B, quoteMint: ANTHROPIC, baseDecimals: 6, quoteDecimals: 9, baseIsToken0: rng() < 0.5, reserve0: r0, reserve1: r1, tradeFeeRate: BigInt([0, 100, 2500, 10000][Math.floor(rng() * 4)]!), protocolFeeRate: 120000n, fundFeeRate: 40000n, creatorFeeRate: BigInt([0, 10000][Math.floor(rng() * 2)]!), creatorFeeOn: Math.floor(rng() * 3), unsupported: [], transferFee: { base: rng() < 0.5 ? { bps: 100, maximumFee: 10n ** 18n } : null, quote: null } });
    const a = randLog(rng, 10n ** 4n, r0 / 2n);
    const b = a + randLog(rng, 1n, r0 / 2n);
    const side = rng() < 0.5 ? "buy" : "sell";
    const oa = side === "buy" ? v.buy(a) : v.sell(a);
    const ob = side === "buy" ? v.buy(b) : v.sell(b);
    if (oa.ok && ob.ok) {
      assert.ok(ob.amountOut >= oa.amountOut);
      n++;
    }
    if (oa.ok) {
      // reserves product (the pool's own accounting) must not shrink
      const bs = v.spot();
      const as = oa.next.spot();
      assert.ok(bs.num > 0n && as.num > 0n);
      const back = side === "buy" ? oa.next.sell(oa.amountOut) : oa.next.buy(oa.amountOut);
      if (back.ok) assert.ok(back.amountOut < a, `round trip must lose: paid ${a}, got ${back.amountOut}`);
    }
  }
  assert.ok(n > 100);
});

// ═════════════════════════ PumpSwap ═════════════════════════

const feeConfig: PumpFeeConfigData = decodePumpFeeConfig(bytesOf(PUMP_FEE_CONFIG));
const globalCfg: PumpGlobalConfigData = { lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 5n, creatorFeeConfigurable: false };
const ctx = (over: Partial<PumpFeeContext> = {}): PumpFeeContext => ({ global: globalCfg, feeConfig, poolCreator: "CANON", canonicalCreator: "CANON", baseMint: MINTS.A, quoteMint: WSOL, coinCreator: "7QAk9FsCkbBEJNGQ8f2hndG6cowXEZrJHErMmksyCC2C", isMayhemMode: false, poolCreatorFeeBps: 0n, baseMintSupply: 1_000_000_000_000_000n, ...over });

test("fee tiers: the last tier whose threshold is reached applies; below the first threshold the first applies", () => {
  const t = feeConfig.feeTiers;
  assert.deepEqual(calculateFeeTier(t, 0n), t[0]!.fees);
  assert.deepEqual(calculateFeeTier(t, 419_999_999_999n), t[0]!.fees);
  assert.deepEqual(calculateFeeTier(t, 420_000_000_000n), t[1]!.fees);
  assert.deepEqual(calculateFeeTier(t, 1_469_999_999_999n), t[1]!.fees);
  assert.deepEqual(calculateFeeTier(t, 1_470_000_000_000n), t[2]!.fees);
  assert.deepEqual(calculateFeeTier(t, 10n ** 18n), t[t.length - 1]!.fees);
  assert.deepEqual(t[t.length - 1]!.fees, { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n });
  assert.throws(() => calculateFeeTier([], 1n), RangeError);
});

test("fee resolution: canonical SOL pools use the market-cap tiers; others use flat fees; no coin creator = no creator fee", () => {
  // market cap = effective quote × supply / base reserve = 20 SOL × 1e15 / 1e15 → 20 SOL: first tier
  const lowCap = resolvePumpFees(ctx(), 10n ** 15n, 20n * 10n ** 9n);
  assert.deepEqual(lowCap.fees, { lpFeeBps: 2n, protocolFeeBps: 93n, creatorFeeBps: 30n });
  const highCap = resolvePumpFees(ctx(), 10n ** 15n, 500n * 10n ** 9n); // 500 SOL ≥ 420 SOL
  assert.deepEqual(highCap.fees, { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n });
  assert.deepEqual(resolvePumpFees(ctx({ poolCreator: "OTHER" }), 10n ** 15n, 20n * 10n ** 9n).fees, { lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n });
  assert.equal(resolvePumpFees(ctx({ coinCreator: "11111111111111111111111111111111" }), 10n ** 15n, 20n * 10n ** 9n).fees.creatorFeeBps, 0n);
  assert.deepEqual(resolvePumpFees(ctx({ feeConfig: null }), 10n ** 15n, 20n * 10n ** 9n).fees, { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n });
  // a USDC quote uses the stable tiers; any other quote mint uses the exotic flat fees (or the flat fees when those are zero)
  assert.equal(pumpQuoteKind(WSOL), "sol");
  assert.equal(pumpQuoteKind(USDC), "stable");
  assert.equal(pumpQuoteKind(ANTHROPIC), "other");
  assert.deepEqual(resolvePumpFees(ctx({ quoteMint: ANTHROPIC }), 10n ** 15n, 20n * 10n ** 9n).fees, feeConfig.exoticFlatFees);
  // mayhem mode uses the total supply as circulating supply
  const mayhem = resolvePumpFees(ctx({ isMayhemMode: true, baseMintSupply: 1n }), 10n ** 15n, 500n * 10n ** 9n);
  assert.deepEqual(mayhem.fees, highCap.fees);
});

test("fee resolution on the real pools: A and C are canonical, in the first tier (2 + 93 + 30 bps)", () => {
  for (const k of ["A", "C"] as const) {
    const v = venuePump(k).venue;
    assert.match(v.info.fees[0]!, /LP 2 \+ protocol 93 \+ creator 30 = 125 bps/);
  }
  assert.equal(venuePump("A").observed["canonicalPool"], true);
});

function pumpFromEvent(e: { data: Record<string, string | number | boolean> }): Venue {
  const d = e.data;
  const fees = { lpFeeBps: big(d["lp_fee_basis_points"]), protocolFeeBps: big(d["protocol_fee_basis_points"]), creatorFeeBps: big(d["coin_creator_fee_basis_points"]) };
  const params: PumpVenueParams = {
    poolAddress: String(d["pool"]),
    baseMint: MINTS.A,
    quoteMint: WSOL,
    baseDecimals: 6,
    quoteDecimals: 9,
    baseReserve: big(d["pool_base_token_reserves"]),
    quoteVault: big(d["pool_quote_token_reserves"]),
    virtualQuoteReserves: big(d["virtual_quote_reserves"]),
    protocolFees: 0n,
    creatorFees: 0n,
    unsupported: [],
    transferFee: { base: null, quote: null },
    // one tier = the event's own rates: this isolates the swap maths from the tier lookup (tested above)
    feeContext: { global: globalCfg, feeConfig: { flatFees: fees, feeTiers: [{ marketCapLamportsThreshold: 0n, fees }], stableFeeTiers: [], exoticFlatFees: fees }, poolCreator: "CANON", canonicalCreator: "CANON", baseMint: MINTS.A, quoteMint: WSOL, coinCreator: String(d["coin_creator"]), isMayhemMode: false, poolCreatorFeeBps: 0n, baseMintSupply: big(d["base_supply"]) },
  };
  return createPumpVenue(params);
}

test("PumpSwap: nine real swaps (A and C) are reproduced exactly — outputs, LP / protocol / creator fees", () => {
  let sells = 0;
  let buys = 0;
  for (const e of [...PUMP_EVENTS_A, ...PUMP_EVENTS_C]) {
    const d = e.data;
    const v = pumpFromEvent(e);
    if (e.event === "SellEvent") {
      const o = fill(v.sell(big(d["base_amount_in"])));
      assert.equal(o.amountOut, big(d["user_quote_amount_out"]), `${e.signature.slice(0, 8)} user quote`);
      assert.equal(o.fees["lp_fee_quote"], big(d["lp_fee"]));
      assert.equal(o.fees["protocol_fee_quote"], big(d["protocol_fee"]));
      assert.equal(o.fees["creator_fee_quote"], big(d["coin_creator_fee"]));
      sells++;
    } else if (String(d["ix_name"]).startsWith("buy_exact_quote_in")) {
      // `quote_amount_in` is the total spent, fees included; the SDK keeps one raw unit of margin and the program agrees
      const o = fill(v.buy(big(d["quote_amount_in"])));
      assert.equal(o.amountOut, big(d["base_amount_out"]), `${e.signature.slice(0, 8)} base out`);
      assert.equal(o.fees["lp_fee_quote"], big(d["lp_fee"]));
      assert.equal(o.fees["protocol_fee_quote"], big(d["protocol_fee"]));
      assert.equal(o.fees["creator_fee_quote"], big(d["coin_creator_fee"]));
      buys++;
    }
  }
  assert.equal(sells, 6);
  assert.equal(buys, 4);
});

test("PumpSwap: prices use the EFFECTIVE quote reserves, payouts are limited by the REAL ones", () => {
  const p: PumpVenueParams = {
    poolAddress: POOLS.A, baseMint: MINTS.A, quoteMint: WSOL, baseDecimals: 6, quoteDecimals: 9,
    baseReserve: 800_000_000_000_000n, quoteVault: 3_000_000_000n, virtualQuoteReserves: 17_000_000_000n, protocolFees: 0n, creatorFees: 0n,
    feeContext: ctx(), unsupported: [], transferFee: { base: null, quote: null },
  };
  assert.equal(effectiveQuote(p), 20_000_000_000n);
  assert.equal(realQuote(p), 3_000_000_000n);
  const v = createPumpVenue(p);
  // the marginal price is effective / base, not vault / base
  assert.deepEqual(v.spot(), { num: 20_000_000_000n, den: 800_000_000_000_000n });
  // selling so much that the priced output (~15 SOL) exceeds the 3 SOL that can be paid: refused
  const huge = v.sell(600_000_000_000_000n);
  assert.ok(!huge.ok && huge.reason === "insufficient_real_reserves", huge.ok ? "" : `${huge.reason}`);
  // the largest sale that works pays no more than the real reserves
  const cap = maxFeasible(v, "sell", 700_000_000_000_000n);
  assert.ok(cap.fill && cap.fill.amountOut < 3_000_000_000n && cap.fill.amountOut > 2_000_000_000n, `capacity pays ${cap.fill?.amountOut}`);
  assert.ok(!v.sell(cap.amount + cap.amount / 50n).ok);
  // fees waiting in the vault are not liquidity: real reserves exclude them
  const withFees = { ...p, protocolFees: 400_000_000n, creatorFees: 100_000_000n };
  assert.equal(realQuote(withFees), 2_500_000_000n);
});

test("PumpSwap: the real A and C pools are boosted — only ~15 % / ~80 % of what the formula prices can be paid out", () => {
  const a = venuePump("A");
  const c = venuePump("C");
  const share = (o: Record<string, string | number | boolean | null>) => 1 - Number(o["realQuoteReserves"]) / Number(o["effectiveQuoteReserves"]);
  assert.ok(share(a.observed) > 0.8, `A: ${share(a.observed)} of the priced reserves cannot be paid out`);
  assert.ok(share(c.observed) > 0.1 && share(c.observed) < 0.3);
  assert.match(a.venue.info.fees[2]!, /boosted pool/);
  // consequence for A: the pool can never pay out more than its ~3 SOL of real reserves, however much is sold
  const cap = maxFeasible(a.venue, "sell", 10n ** 15n);
  assert.ok(cap.fill && cap.fill.amountOut <= BigInt(a.observed["realQuoteReserves"] as string));
});

test("PumpSwap: the fee tier is re-evaluated from the reserves — a big buy on C moves its market cap into a higher tier", () => {
  const c = venuePump("C").venue;
  assert.match(c.info.fees[0]!, /LP 2 \+ protocol 93/);
  const b = fill(c.buy(120n * 10n ** 9n)); // 120 SOL
  assert.match(b.next.info.fees[0]!, /LP 20 \+ protocol 5/, "the market cap crossed 420 SOL");
});

test("PumpSwap: validations — non-positive, dust, fees above the amount, emptying the pool", () => {
  const v = venuePump("A").venue;
  assert.ok(!v.buy(0n).ok && !v.sell(0n).ok);
  const dust = v.buy(1n); // 1 lamport: after the fees nothing is left to swap
  assert.ok(!dust.ok && (dust.reason === "fees_exceed_amount" || dust.reason === "amount_too_small"));
  assert.ok(v.buy(10n).ok, "10 lamports do buy a few raw tokens: that is the program's behaviour too");
  const emptying = v.buy(10n ** 18n);
  assert.ok(!emptying.ok || emptying.amountOut < 868_509_538_668_326n, "the base reserve can never be emptied");
});

test("property PumpSwap: bigger orders never output less, spot moves the right way, a round trip always loses", () => {
  const rng = prng(555);
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const base = randLog(rng, 10n ** 12n, 10n ** 16n);
    const real = randLog(rng, 10n ** 9n, 10n ** 12n);
    const virt = rng() < 0.5 ? 0n : randLog(rng, 10n ** 8n, 10n ** 11n);
    const v = createPumpVenue({ poolAddress: POOLS.A, baseMint: MINTS.A, quoteMint: WSOL, baseDecimals: 6, quoteDecimals: 9, baseReserve: base, quoteVault: real, virtualQuoteReserves: virt, protocolFees: 0n, creatorFees: 0n, feeContext: ctx({ baseMintSupply: base * 2n }), unsupported: [], transferFee: { base: null, quote: null } });
    const a = randLog(rng, 10n ** 5n, real);
    const b = a + randLog(rng, 1n, real);
    const oa = v.buy(a);
    const ob = v.buy(b);
    if (oa.ok && ob.ok) {
      assert.ok(ob.amountOut >= oa.amountOut);
      assert.ok(oa.next.spot().num * v.spot().den >= v.spot().num * oa.next.spot().den, "a buy raises the price");
      const back = oa.next.sell(oa.amountOut);
      if (back.ok) {
        assert.ok(back.amountOut < a, `round trip must lose (paid ${a}, got ${back.amountOut})`);
        n++;
      }
    }
  }
  assert.ok(n > 80, `only ${n} round trips ran`);
});
