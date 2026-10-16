/**
 * Realized PnL by FIFO lots, per token, from a Ledger.
 *
 * Nothing unknown is turned into a number:
 *  - a transferred-in token has no cost basis → lot with cost null;
 *  - a sale beyond the known inventory is an orphan sale;
 *  - an undecodable movement or a transfer out leaves the position UNKNOWN;
 *  - rounds mixing SOL and USD quotes need a rate we do not have → UNKNOWN;
 *  - rent that cannot be attributed with certainty makes the round PARTIAL;
 *  - on an incomplete history a clean-looking round is only PROVISIONAL.
 * PnL = trading result − network fees − tips. Rent deposits / refunds are capital
 * moving in and out of token accounts, not performance: they are tracked apart.
 * Amounts are tracked in raw integer units (bigint); costs are floats.
 */

import { DEFAULT_THRESHOLDS } from "../config.ts";
import type { SmartMoneyThresholds } from "../config.ts";
import type { HistoryCoverage, Ledger, LedgerEntry, QuoteAsset } from "../ledger/types.ts";
import type { MarkPrice, OpenPosition, PartialReason, PnlResult, Round, UnknownReason } from "./types.ts";

interface Lot {
  raw: bigint;
  /** Total cost of the raw still in this lot; null = unknown. */
  cost: number | null;
}

interface State {
  mint: string;
  decimals: number;
  openedAt: number;
  inv: bigint;
  peak: bigint;
  lots: Lot[];
  reasons: Set<UnknownReason>;
  buyQuotes: Set<QuoteAsset>;
  sellQuotes: Set<QuoteAsset>;
  cost: number;
  proceeds: number;
  matchedCost: number;
  matchedProceeds: number;
  feesSol: number;
  tipsSol: number;
  unconvertedFeesSol: number;
  rentDeposit: number;
  rentRefund: number;
  rentUncertain: boolean;
  buys: number;
  sells: number;
  signatures: string[];
}

export interface FifoOptions {
  coverage: HistoryCoverage;
  thresholds?: Pick<SmartMoneyThresholds, "dustRatio">;
  /** Optional mark prices (with provenance) for unrealized value. */
  marks?: Record<string, MarkPrice>;
}

const openState = (mint: string, decimals: number, t: number): State => ({
  mint, decimals, openedAt: t, inv: 0n, peak: 0n, lots: [], reasons: new Set(), buyQuotes: new Set(), sellQuotes: new Set(),
  cost: 0, proceeds: 0, matchedCost: 0, matchedProceeds: 0, feesSol: 0, tipsSol: 0, unconvertedFeesSol: 0, rentDeposit: 0, rentRefund: 0, rentUncertain: false, buys: 0, sells: 0, signatures: [],
});

function addLot(s: State, raw: bigint, cost: number | null): void {
  s.lots.push({ raw, cost });
  s.inv += raw;
  if (s.inv > s.peak) s.peak = s.inv;
}

/** Takes `raw` from the oldest lots. Returns the parts taken (with their share of cost) and the part with no lot behind it. */
function consume(s: State, raw: bigint): { parts: { take: bigint; cost: number | null }[]; orphan: bigint } {
  const parts: { take: bigint; cost: number | null }[] = [];
  let left = raw;
  while (left > 0n && s.lots.length > 0) {
    const lot = s.lots[0];
    const take = left < lot.raw ? left : lot.raw;
    const cost = lot.cost === null ? null : lot.cost * (Number(take) / Number(lot.raw));
    parts.push({ take, cost });
    lot.raw -= take;
    if (lot.cost !== null && cost !== null) lot.cost -= cost;
    if (lot.raw === 0n) s.lots.shift();
    s.inv -= take;
    left -= take;
  }
  return { parts, orphan: left };
}

function apply(s: State, e: LedgerEntry): void {
  s.signatures.push(e.signature);
  if (e.kind !== "undecodable") {
    s.rentDeposit += e.rentDepositLamports;
    s.rentRefund += e.rentRefundLamports;
    if (e.rentStatus === "uncertain") s.rentUncertain = true;
  }
  if (e.kind === "trade") {
    const raw = BigInt(e.tokenRaw);
    s.feesSol += e.quote.asset === "SOL" ? e.feeLamports / 1e9 : 0;
    s.tipsSol += e.quote.asset === "SOL" ? e.tipLamports / 1e9 : 0;
    s.unconvertedFeesSol += e.unconvertedFeeSol;
    if (e.side === "buy") {
      s.buys++;
      s.buyQuotes.add(e.quote.asset);
      s.cost += e.quote.amount;
      addLot(s, raw, e.quote.amount);
    } else {
      s.sells++;
      s.sellQuotes.add(e.quote.asset);
      s.proceeds += e.quote.amount;
      const { parts, orphan } = consume(s, raw);
      for (const p of parts) {
        if (p.cost === null) s.reasons.add("sold_unknown_cost_lot");
        else {
          s.matchedCost += p.cost;
          s.matchedProceeds += e.quote.amount * (Number(p.take) / Number(raw));
        }
      }
      if (orphan > 0n) s.reasons.add("sell_without_known_buy");
    }
  } else if (e.kind === "transfer") {
    const raw = BigInt(e.tokenRaw);
    if (e.direction === "in") {
      s.reasons.add("transfer_in_unknown_cost");
      addLot(s, raw, null);
    } else {
      s.reasons.add("transferred_out");
      if (consume(s, raw).orphan > 0n) s.reasons.add("sell_without_known_buy");
    }
  }
}

function applyLeg(s: State, raw: bigint): void {
  s.reasons.add("undecodable_tx");
  if (raw > 0n) addLot(s, raw, null);
  else consume(s, -raw);
}

function finalize(s: State, closedAt: number, dust: boolean, complete: boolean): Round {
  const quotes = new Set<QuoteAsset>([...s.buyQuotes, ...s.sellQuotes]);
  if (quotes.size > 1) s.reasons.add("mixed_quote");
  const unknownReasons = [...s.reasons];
  const partialReasons: PartialReason[] = s.rentUncertain ? ["rent_unattributed"] : [];
  const status = unknownReasons.length > 0 ? "UNKNOWN" : partialReasons.length > 0 ? "PARTIAL" : complete ? "KNOWN" : "PROVISIONAL";
  const quote = quotes.size === 1 ? [...quotes][0] : null;
  const priced = status !== "UNKNOWN" && quote !== null;
  const cost = priced ? s.cost : null;
  const proceeds = priced ? s.proceeds : null;
  const tradingPnl = priced ? s.proceeds - s.cost : null;
  const sol = quote === "SOL";
  const pnl = tradingPnl === null ? null : sol ? tradingPnl - s.feesSol - s.tipsSol : tradingPnl;
  const outlay = cost === null ? 0 : cost + (sol ? s.feesSol + s.tipsSol : 0);
  return {
    mint: s.mint, openedAt: s.openedAt, closedAt, holdSeconds: Math.max(0, (closedAt - s.openedAt) / 1000), status, unknownReasons, partialReasons, quote,
    cost, proceeds, tradingPnl, pnl, roi: pnl !== null && outlay > 0 ? pnl / outlay : null,
    feesSol: s.feesSol, tipsSol: s.tipsSol, rentDepositedSol: s.rentDeposit / 1e9, rentRecoveredSol: s.rentRefund / 1e9,
    unconvertedFeesSol: s.unconvertedFeesSol, buys: s.buys, sells: s.sells, dustWrittenOff: dust, signatures: s.signatures,
  };
}

function openPosition(s: State, marks: Record<string, MarkPrice>): OpenPosition {
  const quotes = new Set<QuoteAsset>([...s.buyQuotes, ...s.sellQuotes]);
  const quote = quotes.size === 1 ? [...quotes][0] : null;
  const hasUnknownLots = s.lots.some((l) => l.cost === null);
  const known = s.lots.filter((l) => l.cost !== null);
  const knownCost = known.length ? known.reduce((a, l) => a + (l.cost as number), 0) : null;
  const amount = Number(s.inv) / 10 ** s.decimals;
  const mark = marks[s.mint];
  const unrealized = mark && quote !== null && mark.quote === quote && !hasUnknownLots && knownCost !== null && s.reasons.size === 0 && !s.rentUncertain ? { value: amount * mark.price - knownCost, mark } : null;
  const realizedSoFar = quote !== null && s.reasons.size === 0 && !s.rentUncertain ? s.matchedProceeds - s.matchedCost : null;
  return { mint: s.mint, status: "OPEN", openedAt: s.openedAt, amount, knownCost, hasUnknownLots, quote, realizedSoFar, unrealized, unknownReasons: [...s.reasons], signatures: [...s.signatures] };
}

export function computePnl(ledger: Ledger, o: FifoOptions): PnlResult {
  const dustRatio = (o.thresholds ?? DEFAULT_THRESHOLDS).dustRatio;
  const states = new Map<string, State>();
  const rounds: Round[] = [];

  const settle = (s: State, t: number) => {
    const dust = s.inv > 0n;
    if (s.inv === 0n || Number(s.inv) <= Number(s.peak) * dustRatio) {
      rounds.push(finalize(s, t, dust, o.coverage.complete));
      states.delete(s.mint);
    }
  };
  const stateFor = (mint: string, decimals: number, t: number) => {
    let s = states.get(mint);
    if (!s) {
      s = openState(mint, decimals, t);
      states.set(mint, s);
    }
    return s;
  };

  for (const e of ledger.entries) {
    if (e.kind === "undecodable") {
      for (const leg of e.legs) {
        const s = stateFor(leg.mint, leg.decimals, e.time);
        s.signatures.push(e.signature);
        if (e.rentStatus === "uncertain") s.rentUncertain = true;
        applyLeg(s, BigInt(leg.raw));
        settle(s, e.time);
      }
      continue;
    }
    const s = stateFor(e.mint, e.decimals, e.time);
    apply(s, e);
    settle(s, e.time);
  }

  const open = [...states.values()].map((s) => openPosition(s, o.marks ?? {}));
  const c = { feeLamports: ledger.otherCosts.feeLamports, tipLamports: 0, dep: ledger.otherCosts.rentDepositLamports, ref: ledger.otherCosts.rentRefundLamports, unc: ledger.otherCosts.uncertainRentTxs };
  for (const e of ledger.entries) {
    c.feeLamports += e.feeLamports;
    c.tipLamports += e.tipLamports;
    c.dep += e.rentDepositLamports;
    c.ref += e.rentRefundLamports;
    if (e.rentStatus === "uncertain") c.unc++;
  }
  rounds.sort((a, b) => a.closedAt - b.closedAt);
  return {
    wallet: ledger.wallet, coverage: o.coverage, rounds, open,
    failedFeeSol: ledger.failedFeeLamports / 1e9, failedTxCount: ledger.failedTxCount, ignoredTxCount: ledger.ignored.length,
    costs: { feesSol: c.feeLamports / 1e9, tipsSol: c.tipLamports / 1e9, rentDepositedSol: c.dep / 1e9, rentRecoveredSol: c.ref / 1e9, uncertainRentTxs: c.unc },
  };
}
