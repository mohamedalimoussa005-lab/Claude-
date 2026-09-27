/**
 * Behavioural bot / high-frequency signals from a wallet's normalized
 * transactions (step 4.2). Classification comes from balances
 * (`classifyForWallet`), never from a provider label. Pure; thresholds in
 * WALLET_CONFIG.bot. A small sample judges nothing: every signal stays false.
 */

import { classifyForWallet } from "../history/classify.ts";
import type { HistoryTx } from "../history/types.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";

export interface BotSignals {
  /** Transactions looked at (succeeded, normalized). */
  sampleSize: number;
  spanMinutes: number | null;
  txPerMinute: number | null;
  trades: number;
  distinctTokens: number;
  /** BUY then SELL of the same token. */
  roundTrips: number;
  fastRoundTrips: number;
  /** Round trips selling exactly the amount bought (±0.1 %). */
  identicalAmountRoundTrips: number;
  medianHoldSeconds: number | null;
  averageTicketSol: number | null;
  highFrequency: boolean;
  fastFlipper: boolean;
  manyTokens: boolean;
  microTickets: boolean;
  /** High frequency together with fast flips or many tokens. */
  botLike: boolean;
  evidence: string[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function detectBotSignals(txs: HistoryTx[], wallet: string, c: WalletConfig = WALLET_CONFIG): BotSignals {
  const b = c.bot;
  const ok = txs.filter((t) => !t.failed && t.time !== null).sort((x, y) => x.time! - y.time!);
  const times = ok.map((t) => t.time!);
  const spanMinutes = times.length >= 2 ? (times[times.length - 1] - times[0]) / 60_000 : null;
  const txPerMinute = spanMinutes && spanMinutes > 0 ? ok.length / spanMinutes : null;

  const trades = ok.map((t) => ({ t, c: classifyForWallet(t, wallet) })).filter((x) => x.c.kind === "BUY" || x.c.kind === "SELL");
  const distinctTokens = new Set(trades.map((x) => x.c.mint)).size;
  const buys = trades.filter((x) => x.c.kind === "BUY");
  const usedSells = new Set<string>();
  const holds: number[] = [];
  let identical = 0;
  for (const buy of buys) {
    const sell = trades.find((x) => x.c.kind === "SELL" && x.c.mint === buy.c.mint && x.t.time! >= buy.t.time! && !usedSells.has(x.t.signature));
    if (!sell) continue;
    usedSells.add(sell.t.signature);
    holds.push((sell.t.time! - buy.t.time!) / 1000);
    const a = buy.c.tokenAmount ?? 0;
    if (a > 0 && Math.abs((sell.c.tokenAmount ?? 0) - a) <= a * 0.001) identical++;
  }
  const fast = holds.filter((h) => h <= b.fastRoundTripSeconds).length;
  const averageTicketSol = trades.length ? trades.reduce((s, x) => s + Math.abs(x.c.sol), 0) / trades.length : null;

  const enough = ok.length >= b.minTransactions;
  const highFrequency = enough && txPerMinute !== null && txPerMinute >= b.highFrequencyTxPerMinute;
  const fastFlipper = enough && fast >= b.minFastRoundTrips && buys.length > 0 && fast / buys.length >= b.fastRoundTripShare;
  const manyTokens = enough && distinctTokens >= b.manyTokens;
  const microTickets = enough && trades.length >= 10 && averageTicketSol !== null && averageTicketSol < c.flags.microTicketSol;
  const botLike = highFrequency && (fastFlipper || manyTokens);

  const evidence: string[] = [];
  if (highFrequency) evidence.push(`${txPerMinute!.toFixed(1)} transactions/min sur ${spanMinutes!.toFixed(0)} min`);
  if (fastFlipper) evidence.push(`${fast}/${buys.length} achats revendus en ≤ ${b.fastRoundTripSeconds} s (médiane ${median(holds)!.toFixed(0)} s)`);
  if (identical >= b.minFastRoundTrips) evidence.push(`${identical} reventes de la quantité exacte achetée`);
  if (manyTokens) evidence.push(`${distinctTokens} tokens différents dans l'échantillon`);
  if (microTickets) evidence.push(`ticket moyen ${averageTicketSol!.toFixed(4)} SOL`);

  return {
    sampleSize: ok.length,
    spanMinutes,
    txPerMinute,
    trades: trades.length,
    distinctTokens,
    roundTrips: holds.length,
    fastRoundTrips: fast,
    identicalAmountRoundTrips: identical,
    medianHoldSeconds: median(holds),
    averageTicketSol,
    highFrequency,
    fastFlipper,
    manyTokens,
    microTickets,
    botLike,
    evidence,
  };
}
