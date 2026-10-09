/**
 * Depth engine: turns a Venue into a report. Everything is computed with exact integers;
 * floats appear only in the human-readable fields of the report.
 *
 * Definitions
 *   price impact (depth)   the marginal (spot) price after the trade has moved by X % from the spot
 *                          before it. "Ask depth +X %" = the quote you must pay to push the spot up by X %.
 *                          "Bid depth −X %" = the base you must sell to push the spot down by X %, and the
 *                          quote you get for it.
 *   execution impact       average execution price versus the starting spot (what an order actually pays).
 *   round trip             buy with a quote budget, then immediately sell the base actually received
 *                          (net of fees and Token-2022 taxes) into the pool state the buy left.
 *
 * A simulation is a calculation on a frozen snapshot. It is not a quote, not an execution guarantee,
 * and does not model priority fees, tips, MEV, other pools, token-program restrictions (frozen
 * accounts, transfer hooks, pausing) or anything that changes after the snapshot slot.
 */

import { fromHuman, ratioGte, ratioToNumber, toHuman } from "./math.ts";
import type { Ratio } from "./math.ts";
import type { FailReason, SwapFill, SwapOutcome, Venue, VenueInfo } from "./types.ts";

export interface DepthTargets {
  /** Price impacts, basis points. */
  impactsBps: number[];
  /** Buy orders and round trips, in USD. */
  ordersUsd: number[];
  /** Sells, percent of the base token's supply. */
  supplySellPercents: number[];
}

export const DEFAULT_TARGETS: DepthTargets = { impactsBps: [50, 100, 500, 1000], ordersUsd: [50, 100, 500, 1000, 10000], supplySellPercents: [1, 5] };

export interface QuotePrice {
  /** USD per whole quote token, or null when no price is available (USD fields are then null). */
  usdPerQuote: number | null;
  /** Where the price comes from (e.g. "stable assumption", "DEX Screener priceUsd/priceNative"). */
  source: string;
}

export interface DepthContext {
  venue: Venue;
  quote: QuotePrice;
  baseSupply: bigint;
}

/** An amount in raw units, human units and (when the quote price is known) USD. */
export interface AmountView {
  raw: string;
  human: number;
  usd: number | null;
}

export interface DepthPoint {
  impactBps: number;
  /** False when the pool cannot reach that impact (liquidity runs out first). */
  reached: boolean;
  /** Ask side: the quote paid. Bid side: the base sold. When not reached: the largest feasible amount. */
  input: AmountView | null;
  /** Ask side: the base received. Bid side: the quote received. */
  output: AmountView | null;
  /** Spot move actually achieved by `input`, percent. */
  achievedImpactPct: number | null;
  /** Why it was not reached, or a caveat. */
  note: string | null;
}

export interface TradeView {
  ok: boolean;
  reason: FailReason | "quote_price_unavailable" | null;
  detail: string | null;
  amountIn: AmountView | null;
  amountOut: AmountView | null;
  /** Average execution price versus the starting spot, percent (buy: paid more, sell: received less). */
  executionImpactPct: number | null;
  /** Fees paid (raw units) by label. */
  fees: Record<string, string>;
  /** When the trade cannot execute: the largest amount that can, and what it yields. */
  capacity: { input: AmountView; output: AmountView } | null;
}

export interface SizedTrade extends TradeView {
  label: string;
}

export interface RoundTripView {
  usd: number;
  ok: boolean;
  buy: TradeView;
  sell: TradeView | null;
  quoteIn: AmountView | null;
  /** Quote recovered by selling everything bought; when the sell fails, the most the pool can pay for it. */
  quoteBack: AmountView | null;
  /** (1 − back / in) × 100. */
  lossPct: number | null;
  note: string | null;
}

export interface DepthReport {
  info: VenueInfo;
  spot: { quotePerBase: number; usdPerBase: number | null };
  quote: QuotePrice;
  baseSupply: string;
  ask: DepthPoint[];
  bid: DepthPoint[];
  buys: SizedTrade[];
  supplySells: SizedTrade[];
  roundTrips: RoundTripView[];
  /** Bid quote obtainable at −1 % over ask quote needed at +1 % (capacity values when a side cannot reach it). */
  exitToEntryRatio1Pct: number | null;
  /** True when no result depends on an unsupported feature or on unread data. */
  complete: boolean;
  disclaimer: string;
}

export const DISCLAIMER = "Simulation on a frozen snapshot: not a quote and not a guarantee of execution. Ignores priority fees, tips, MEV, other pools, token-program restrictions and any change after the snapshot.";

const SEARCH_BITS = 128;

function view(raw: bigint, decimals: number, usdPerUnit: number | null): AmountView {
  const human = toHuman(raw, decimals);
  return { raw: raw.toString(), human, usd: usdPerUnit === null ? null : human * usdPerUnit };
}

const isGrowReason = (r: FailReason) => r === "amount_too_small" || r === "fees_exceed_amount";

type Side = "buy" | "sell";
const trade = (v: Venue, side: Side, amount: bigint): SwapOutcome => (side === "buy" ? v.buy(amount) : v.sell(amount));

/** Spot after the fill, moved by `bps` in the direction of the side. */
function targetSpot(spot: Ratio, side: Side, bps: number): Ratio {
  const up = side === "buy";
  return { num: spot.num * BigInt(10_000 + (up ? bps : -bps)), den: spot.den * 10_000n };
}
const meets = (side: Side, after: Ratio, target: Ratio) => (side === "buy" ? ratioGte(after, target) : ratioGte(target, after));

const pct = (after: Ratio, before: Ratio): number => (ratioToNumber({ num: after.num * before.den, den: after.den * before.num }) - 1) * 100;

interface SearchResult {
  reached: boolean;
  /** Smallest input reaching the target, or the largest feasible input when not reached. */
  amount: bigint;
  fill: SwapFill | null;
  note: string | null;
}

/** Smallest input amount whose resulting spot has moved by `bps`; otherwise the largest input the pool can take. */
export function searchDepth(venue: Venue, side: Side, bps: number): SearchResult {
  const spot0 = venue.spot();
  const target = targetSpot(spot0, side, bps);
  let lo = 0n; // largest amount known to be insufficient (or too small)
  let hi = 1n;
  let found: SwapFill | null = null;
  let capacityReason: string | null = null;
  for (let i = 0; i < SEARCH_BITS; i++) {
    const o = trade(venue, side, hi);
    if (o.ok) {
      if (meets(side, o.next.spot(), target)) {
        found = o;
        break;
      }
      lo = hi;
    } else if (isGrowReason(o.reason)) {
      lo = hi;
    } else {
      capacityReason = `${o.reason}: ${o.detail}`;
      break;
    }
    hi *= 2n;
  }
  if (found) {
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      const o = trade(venue, side, mid);
      if (o.ok && meets(side, o.next.spot(), target)) {
        hi = mid;
        found = o;
      } else lo = mid;
    }
    const exact = trade(venue, side, hi);
    return { reached: true, amount: hi, fill: exact.ok ? exact : found, note: null };
  }
  if (capacityReason === null) return { reached: false, amount: lo, fill: null, note: "no amount below the search bound reaches that impact" };
  // capacity: the largest feasible amount lies in [lo, hi)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (trade(venue, side, mid).ok) lo = mid;
    else hi = mid;
  }
  const best = lo > 0n ? trade(venue, side, lo) : null;
  return { reached: false, amount: lo, fill: best && best.ok ? best : null, note: `the pool runs out of liquidity first (${capacityReason})` };
}

/** Largest input the pool can execute on this side (capacity), by exponential then binary search. */
export function maxFeasible(venue: Venue, side: Side, upperBound: bigint): { amount: bigint; fill: SwapFill | null } {
  let lo = 0n;
  let hi = upperBound;
  if (trade(venue, side, hi).ok) {
    const f = trade(venue, side, hi);
    return { amount: hi, fill: f.ok ? f : null };
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (trade(venue, side, mid).ok) lo = mid;
    else hi = mid;
  }
  const f = lo > 0n ? trade(venue, side, lo) : null;
  return { amount: lo, fill: f && f.ok ? f : null };
}

export function analyzeDepth(ctx: DepthContext, targets: DepthTargets = DEFAULT_TARGETS): DepthReport {
  const { venue, quote } = ctx;
  const { baseDecimals, quoteDecimals } = venue.info;
  const spot0 = venue.spot();
  const usdQuote = quote.usdPerQuote;
  const quoteView = (raw: bigint) => view(raw, quoteDecimals, usdQuote);
  const baseUsdPerUnit = usdQuote === null ? null : (ratioToNumber(spot0, baseDecimals - quoteDecimals) as number) * usdQuote;
  const baseView = (raw: bigint) => view(raw, baseDecimals, baseUsdPerUnit);

  const tradeView = (side: Side, start: Venue, amount: bigint, o: SwapOutcome): TradeView => {
    const inView = side === "buy" ? quoteView : baseView;
    const outView = side === "buy" ? baseView : quoteView;
    if (!o.ok) {
      const cap = maxFeasible(start, side, amount);
      return {
        ok: false,
        reason: o.reason,
        detail: o.detail,
        amountIn: inView(amount),
        amountOut: null,
        executionImpactPct: null,
        fees: {},
        capacity: cap.fill ? { input: inView(cap.fill.amountIn), output: outView(cap.fill.amountOut) } : null,
      };
    }
    const spot = start.spot();
    // average price (quote per base) of the fill, as a ratio, versus the starting spot
    const avg: Ratio = side === "buy" ? { num: o.amountIn, den: o.amountOut } : { num: o.amountOut, den: o.amountIn };
    const exec = side === "buy" ? pct(avg, spot) : -pct(avg, spot);
    return {
      ok: true,
      reason: null,
      detail: null,
      amountIn: inView(o.amountIn),
      amountOut: outView(o.amountOut),
      executionImpactPct: exec,
      fees: Object.fromEntries(Object.entries(o.fees).map(([k, v]) => [k, v.toString()])),
      capacity: null,
    };
  };

  const point = (side: Side, bps: number): DepthPoint => {
    const r = searchDepth(venue, side, bps);
    const inView = side === "buy" ? quoteView : baseView;
    const outView = side === "buy" ? baseView : quoteView;
    const fill = r.fill;
    const achieved = fill ? (side === "buy" ? pct(fill.next.spot(), spot0) : -pct(fill.next.spot(), spot0)) : null;
    return { impactBps: bps, reached: r.reached, input: fill ? inView(fill.amountIn) : null, output: fill ? outView(fill.amountOut) : null, achievedImpactPct: achieved, note: r.note };
  };

  const ask = targets.impactsBps.map((b) => point("buy", b));
  const bid = targets.impactsBps.map((b) => point("sell", b));

  const quoteRawForUsd = (usd: number): bigint | null => (usdQuote === null || usdQuote <= 0 ? null : fromHuman(usd / usdQuote, quoteDecimals));
  const unavailable = (): TradeView => ({ ok: false, reason: "quote_price_unavailable", detail: "no USD price for the quote token", amountIn: null, amountOut: null, executionImpactPct: null, fees: {}, capacity: null });

  const buys: SizedTrade[] = targets.ordersUsd.map((usd) => {
    const raw = quoteRawForUsd(usd);
    if (raw === null) return { label: `buy $${usd}`, ...unavailable() };
    return { label: `buy $${usd}`, ...tradeView("buy", venue, raw, venue.buy(raw)) };
  });

  const supplySells: SizedTrade[] = targets.supplySellPercents.map((p) => {
    const raw = (ctx.baseSupply * BigInt(Math.round(p * 100))) / 10_000n;
    return { label: `sell ${p}% of supply`, ...tradeView("sell", venue, raw, venue.sell(raw)) };
  });

  const roundTrips: RoundTripView[] = targets.ordersUsd.map((usd) => {
    const raw = quoteRawForUsd(usd);
    if (raw === null) return { usd, ok: false, buy: unavailable(), sell: null, quoteIn: null, quoteBack: null, lossPct: null, note: "no USD price for the quote token" };
    const b = venue.buy(raw);
    const buyView = tradeView("buy", venue, raw, b);
    if (!b.ok) return { usd, ok: false, buy: buyView, sell: null, quoteIn: quoteView(raw), quoteBack: null, lossPct: null, note: "the buy cannot execute" };
    const s = b.next.sell(b.amountOut);
    const sellView = tradeView("sell", b.next, b.amountOut, s);
    if (!s.ok) {
      const cap = sellView.capacity;
      const back = cap ? BigInt(cap.output.raw) : 0n;
      return { usd, ok: false, buy: buyView, sell: sellView, quoteIn: quoteView(b.amountIn), quoteBack: quoteView(back), lossPct: (1 - Number(back) / Number(b.amountIn)) * 100, note: "the base bought cannot all be sold back; quoteBack is the most the pool can pay for it" };
    }
    return { usd, ok: true, buy: buyView, sell: sellView, quoteIn: quoteView(b.amountIn), quoteBack: quoteView(s.amountOut), lossPct: (1 - Number(s.amountOut) / Number(b.amountIn)) * 100, note: null };
  });

  const ask1 = ask.find((p) => p.impactBps === 100);
  const bid1 = bid.find((p) => p.impactBps === 100);
  const exitToEntry = ask1?.input && bid1?.output ? Number(bid1.output.raw) / Number(ask1.input.raw) : null;

  const complete = venue.info.unsupported.length === 0 && venue.info.dataComplete;
  return {
    info: venue.info,
    spot: { quotePerBase: ratioToNumber(spot0, baseDecimals - quoteDecimals), usdPerBase: baseUsdPerUnit },
    quote,
    baseSupply: ctx.baseSupply.toString(),
    ask,
    bid,
    buys,
    supplySells,
    roundTrips,
    exitToEntryRatio1Pct: exitToEntry,
    complete,
    disclaimer: DISCLAIMER,
  };
}
