/**
 * Artificial-volume indicators for one token.
 *
 *   observed   the swaps themselves
 *   computed   round trips (a wallet buys and sells the same tokens within a short time), repeated trade sizes,
 *              regular intervals, concentration, token transfer cycles
 *   motif       wallets that repeat BALANCED round trips (many matched buy/sell cycles whose totals are equal)
 *
 * There is deliberately no significance test here: buying and later selling is what traders do (the 5D audit showed
 * a label-permutation test flags nearly every organic market). Measures are descriptive and carry their
 * counter-explanations; a level of 30 % or a motif is a pointer for review, not an anomaly verdict.
 *
 * None of this proves that volume is fake: market makers, arbitrageurs and scalpers also trade both ways, and
 * known bots/routers are left out of the judgement (their volume is counted apart). The output is a measurement
 * with its counter-explanations, never a verdict.
 */

import type { CoordinationConfig, KnownEntity, SwapEvent } from "./model.ts";
import { DEFAULT_CONFIG } from "./model.ts";
import type { TokenTransfer } from "./normalize.ts";
import { cv, similar } from "./stats.ts";

export const WASH_COUNTER_EXPLANATIONS: readonly string[] = [
  "teneur de marché ou bot d'arbitrage qui achète et revend légitimement",
  "scalpers humains: achat puis revente rapide",
  "routeur ou agrégateur dont les swaps sont regroupés sous un même wallet",
  "échantillon de transactions incomplet: des contreparties ne sont pas lues",
];

export interface RoundTrip {
  wallet: string;
  buySignature: string;
  sellSignature: string;
  baseMatched: bigint;
  quoteBuy: bigint;
  quoteSell: bigint;
  seconds: number | null;
}

export interface MotifWallet {
  wallet: string;
  cycles: number;
  boughtQuote: bigint;
  soldQuote: bigint;
  /** |bought − sold| / max(bought, sold). */
  imbalance: number;
}

export interface WalletCadence {
  wallet: string;
  trades: number;
  modalSizeShare: number;
  intervalCv: number | null;
  metronomic: boolean;
}

export interface WashReport {
  swaps: number;
  grossQuote: bigint;
  /** Volume of known entities (routers, bots, services), left out of every judgement below. */
  excludedQuote: bigint;
  judgedSwaps: number;
  judgedQuote: bigint;
  distinctTraders: number;
  top5VolumeShare: number | null;
  /** Share of the judged volume traded by the token creator, when known (0..1). */
  creatorVolumeShare: number | null;
  roundTrips: RoundTrip[];
  roundTripQuote: bigint;
  roundTripShare: number | null;
  roundTripWallets: string[];
  /** Wallets repeating balanced round trips (market makers, arbitrage bots and wash trading all look like this). */
  motifWallets: MotifWallet[];
  /** Share of the judged volume traded by the motif wallets (0..1), or null without volume. */
  motifVolumeShare: number | null;
  cadence: WalletCadence[];
  /** Directed cycles of exact token transfers among wallets (A→B→A, A→B→C→A). */
  transferCycles: string[][];
  flags: string[];
  counterExplanations: readonly string[];
  notes: string[];
}

export interface WashArgs {
  swaps: readonly SwapEvent[];
  transfers: readonly TokenTransfer[];
  entities: ReadonlyMap<string, KnownEntity>;
  cfg?: CoordinationConfig;
  /** Notes inherited from the data coverage (partial history etc.). */
  coverageNotes?: readonly string[];
}

const time = (s: SwapEvent): number => s.slot * 0.4;
const timeOf = (a: SwapEvent, b: SwapEvent): number => (a.blockTime !== null && b.blockTime !== null ? b.blockTime - a.blockTime : time(b) - time(a));
const order = (a: SwapEvent, b: SwapEvent) => a.slot - b.slot || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);

/** FIFO matching of sells against earlier buys of the same wallet within `seconds`. */
export function matchRoundTrips(swaps: readonly SwapEvent[], traderOf: (i: number) => string, cfg: CoordinationConfig): RoundTrip[] {
  const idx = swaps.map((_, i) => i).sort((i, j) => order(swaps[i]!, swaps[j]!));
  const open = new Map<string, { s: SwapEvent; remaining: bigint; quoteLeft: bigint }[]>();
  const out: RoundTrip[] = [];
  for (const i of idx) {
    const s = swaps[i]!;
    const w = traderOf(i);
    if (s.side === "buy") {
      (open.get(w) ?? open.set(w, []).get(w)!).push({ s, remaining: s.baseAmount, quoteLeft: s.quoteAmount });
      continue;
    }
    const queue = open.get(w);
    if (!queue) continue;
    let toSell = s.baseAmount;
    let sellQuoteLeft = s.quoteAmount;
    for (const b of queue) {
      if (toSell === 0n) break;
      if (b.remaining === 0n) continue;
      const dt = timeOf(b.s, s);
      if (dt > cfg.wash.roundTripSeconds) continue;
      const take = b.remaining < toSell ? b.remaining : toSell;
      const qBuy = (b.quoteLeft * take) / b.remaining;
      const qSell = (sellQuoteLeft * take) / toSell;
      out.push({ wallet: w, buySignature: b.s.signature, sellSignature: s.signature, baseMatched: take, quoteBuy: qBuy, quoteSell: qSell, seconds: dt });
      b.remaining -= take;
      b.quoteLeft -= qBuy;
      toSell -= take;
      sellQuoteLeft -= qSell;
    }
  }
  // a match only counts when the wallet sold back most of what a buy gave it
  return out.filter((r) => {
    const buy = swaps.find((x) => x.signature === r.buySignature)!;
    return Number(r.baseMatched) >= cfg.wash.matchMinFraction * Number(buy.baseAmount) || r.baseMatched === buy.baseAmount;
  });
}

function findCycles(transfers: readonly TokenTransfer[]): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const t of transfers) (adj.get(t.from) ?? adj.set(t.from, new Set()).get(t.from)!).add(t.to);
  const seen = new Set<string>();
  const cycles: string[][] = [];
  for (const a of [...adj.keys()].sort()) {
    for (const b of adj.get(a) ?? []) {
      if (adj.get(b)?.has(a) && a < b && !seen.has(`${a}|${b}`)) {
        seen.add(`${a}|${b}`);
        cycles.push([a, b, a]);
      }
      for (const c of adj.get(b) ?? []) {
        if (c !== a && c !== b && adj.get(c)?.has(a)) {
          const ring = [a, b, c];
          const min = [...ring].sort()[0]!;
          if (a !== min) continue;
          const key = ring.join("|");
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push([a, b, c, a]);
          }
        }
      }
    }
  }
  return cycles;
}

export function analyzeWash(args: WashArgs): WashReport {
  const cfg = args.cfg ?? DEFAULT_CONFIG;
  const notes = [...(args.coverageNotes ?? [])];
  const swaps = [...args.swaps].sort(order);
  // known routers/bots/services are left out; the creator is NOT (a creator can trade against their own pool)
  const isExcluded = (w: string) => {
    const e = args.entities.get(w);
    return e !== undefined && e.kind !== "creator";
  };
  const excludedSwaps = swaps.filter((s) => isExcluded(s.trader));
  const judged = swaps.filter((s) => !isExcluded(s.trader));
  const sum = (xs: readonly SwapEvent[]) => xs.reduce((a, s) => a + s.quoteAmount, 0n);
  const gross = sum(swaps);
  const judgedQuote = sum(judged);

  const volBy = new Map<string, bigint>();
  for (const s of judged) volBy.set(s.trader, (volBy.get(s.trader) ?? 0n) + s.quoteAmount);
  const top5 = [...volBy.values()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, 5).reduce((a, b) => a + b, 0n);

  const creatorWallet = [...args.entities].find(([, e]) => e.kind === "creator")?.[0] ?? null;
  const creatorVol = creatorWallet === null ? null : volBy.get(creatorWallet) ?? 0n;

  const rts = matchRoundTrips(judged, (i) => judged[i]!.trader, cfg);
  const rtVol = rts.reduce((a, r) => a + r.quoteBuy + r.quoteSell, 0n);
  const share = judgedQuote > 0n ? Number((rtVol * 1_000_000n) / judgedQuote) / 1_000_000 : null;

  // repeated balanced round trips per wallet (descriptive)
  const rtBy = new Map<string, { cycles: number; buy: bigint; sell: bigint }>();
  for (const r of rts) {
    const e = rtBy.get(r.wallet) ?? { cycles: 0, buy: 0n, sell: 0n };
    e.cycles++;
    e.buy += r.quoteBuy;
    e.sell += r.quoteSell;
    rtBy.set(r.wallet, e);
  }
  const motifWallets: MotifWallet[] = [];
  for (const [wallet, e] of [...rtBy].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const hi = e.buy > e.sell ? e.buy : e.sell;
    if (e.cycles < cfg.wash.motifMinCycles || hi === 0n) continue;
    const imbalance = Number((e.buy > e.sell ? e.buy - e.sell : e.sell - e.buy) * 1_000_000n / hi) / 1_000_000;
    if (imbalance <= cfg.wash.motifBalanceTolerance) motifWallets.push({ wallet, cycles: e.cycles, boughtQuote: e.buy, soldQuote: e.sell, imbalance });
  }
  const motifVol = motifWallets.reduce((a, m) => a + (volBy.get(m.wallet) ?? 0n), 0n);

  // cadence per wallet
  const cadence: WalletCadence[] = [];
  const byWallet = new Map<string, SwapEvent[]>();
  for (const s of judged) (byWallet.get(s.trader) ?? byWallet.set(s.trader, []).get(s.trader)!).push(s);
  for (const [wallet, list] of [...byWallet].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < cfg.wash.minTradesForRegularity) continue;
    let best = 0;
    for (const s of list) best = Math.max(best, list.filter((t) => similar(t.quoteAmount, s.quoteAmount, cfg.wash.sizeTolerance)).length);
    const times = list.map(time).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const c = cv(gaps);
    const modal = best / list.length;
    cadence.push({ wallet, trades: list.length, modalSizeShare: modal, intervalCv: c, metronomic: modal >= cfg.wash.repeatShareFlag && c !== null && c < cfg.wash.intervalCvFlag });
  }

  const cycles = findCycles(args.transfers);
  const flags: string[] = [];
  if (share !== null && share >= cfg.wash.roundTripShareFlag) flags.push(`aller-retours = ${(share * 100).toFixed(1)} % du volume jugé (niveau de repérage ${cfg.wash.roundTripShareFlag * 100} %, non validé)`);
  if (motifWallets.length > 0) flags.push(`${motifWallets.length} wallet(s) répètent des aller-retours équilibrés (≥ ${cfg.wash.motifMinCycles} cycles, écart ≤ ${cfg.wash.motifBalanceTolerance * 100} %): motif descriptif`);
  if (cadence.some((c) => c.metronomic)) flags.push(`${cadence.filter((c) => c.metronomic).length} wallet(s) à taille et rythme réguliers`);
  if (cycles.length > 0) flags.push(`${cycles.length} cycle(s) de transferts du token entre wallets`);
  if (excludedSwaps.length > 0) notes.push(`${excludedSwaps.length} swap(s) d'entités connues (routeurs, bots, services) exclus du jugement`);
  notes.push("les montants de cotation sont approximatifs (en SOL: frais, loyers de comptes et pourboires retirés)");

  return {
    swaps: swaps.length,
    grossQuote: gross,
    excludedQuote: sum(excludedSwaps),
    judgedSwaps: judged.length,
    judgedQuote: judgedQuote,
    distinctTraders: new Set(judged.map((s) => s.trader)).size,
    creatorVolumeShare: judgedQuote > 0n && creatorVol !== null ? Number((creatorVol * 1_000_000n) / judgedQuote) / 1_000_000 : null,
    top5VolumeShare: judgedQuote > 0n ? Number((top5 * 1_000_000n) / judgedQuote) / 1_000_000 : null,
    roundTrips: rts,
    roundTripQuote: rtVol,
    roundTripShare: share,
    roundTripWallets: [...new Set(rts.map((r) => r.wallet))].sort(),
    motifWallets,
    motifVolumeShare: judgedQuote > 0n ? Number((motifVol * 1_000_000n) / judgedQuote) / 1_000_000 : null,
    cadence,
    transferCycles: cycles,
    flags,
    counterExplanations: WASH_COUNTER_EXPLANATIONS,
    notes,
  };
}
