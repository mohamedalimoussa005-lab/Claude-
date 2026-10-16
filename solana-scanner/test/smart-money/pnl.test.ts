import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWallet } from "../../src/smart-money/pnl/profile.ts";
import { wilson } from "../../src/smart-money/pnl/stats.ts";
import { profileEvent } from "../../src/smart-money/pnl/events.ts";
import { validateEvent } from "../../src/smart-money/contract/events.ts";
import { USDC_MINT, addr, buy, mulberry32, sell, tx, DEMO_START, demoWalletTxs } from "../../src/smart-money/demo/fixtures.ts";
import { DEFAULT_THRESHOLDS } from "../../src/smart-money/config.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import { closeTo } from "./helpers.ts";

const W = addr(11);
const M = addr(40);
const H = 3_600_000;
const T = DEMO_START;
const complete = { complete: true, oldestTime: null };
const run = (txs: HistoryTx[], cov: { complete: boolean; oldestTime: number | null } = complete, config = { thresholds: DEFAULT_THRESHOLDS, tipAccounts: [] as string[] }) => analyzeWallet(W, txs, { coverage: cov, config });

test("a clean round trip: trading PnL, then fees, then net PnL; status KNOWN", () => {
  const { pnl, profile } = run([buy("b", T, W, M, 1000, 1), sell("s", T + H, W, M, 1000, 2)]);
  const [r] = pnl.rounds;
  assert.equal(r.status, "KNOWN");
  assert.ok(closeTo(r.cost, 0.999995) && closeTo(r.proceeds, 2.000005) && closeTo(r.tradingPnl, 1.00001));
  assert.ok(closeTo(r.feesSol, 0.00001));
  assert.ok(closeTo(r.pnl, 1) && closeTo(r.roi, 1, 1e-4)); // net of fees: exactly the 2 − 1 the wallet really made
  assert.equal(r.holdSeconds, 3600);
  assert.equal(profile.counts.known, 1);
});

test("FIFO: the oldest lot is sold first; partial sells keep the position open and separate", () => {
  const txs = [buy("b1", T, W, M, 100, 1), buy("b2", T + H, W, M, 100, 3), sell("s1", T + 2 * H, W, M, 150, 6)];
  const half = run(txs);
  assert.equal(half.pnl.rounds.length, 0);
  const [open] = half.pnl.open;
  assert.equal(open.status, "OPEN");
  assert.equal(open.amount, 50);
  assert.ok(closeTo(open.knownCost, 1.5, 1e-4)); // 50 left of the 3 SOL lot (trading cost, fee separated)
  assert.ok(closeTo(open.realizedSoFar, 6 - 2.5, 1e-4)); // 100@1 + 50@1.5 matched
  assert.equal(open.unrealized, null); // no mark price → UNKNOWN, not 0

  const closed = run([...txs, sell("s2", T + 3 * H, W, M, 50, 1)]);
  assert.equal(closed.pnl.open.length, 0);
  assert.ok(closeTo(closed.pnl.rounds[0].pnl, 7 - 4));
});

test("a mark price (supplied with its source) values an open position; a different quote does not", () => {
  const txs = [buy("b", T, W, M, 100, 1)];
  const mark = { price: 0.05, quote: "SOL" as const, asOf: T, source: "test" };
  const ok = analyzeWallet(W, txs, { coverage: complete, marks: { [M]: mark } }).pnl.open[0];
  assert.ok(closeTo(ok.unrealized?.value ?? null, 4, 1e-4)); // 100 × 0.05 − 1
  const wrong = analyzeWallet(W, txs, { coverage: complete, marks: { [M]: { ...mark, quote: "USD" } } }).pnl.open[0];
  assert.equal(wrong.unrealized, null);
});

test("rounding dust does not keep a position open forever, but its cost stays in the PnL", () => {
  const { pnl } = run([buy("b", T, W, M, 1_000_000, 1), sell("s", T + H, W, M, 999_500, 1.5)]);
  assert.equal(pnl.open.length, 0);
  assert.equal(pnl.rounds[0].dustWrittenOff, true);
  assert.ok(closeTo(pnl.rounds[0].pnl, 0.5));
});

test("a token received by transfer has no cost: selling it is UNKNOWN, never a free profit", () => {
  const { pnl, profile } = run([tx({ sig: "in", time: T, wallet: W, signer: false, tokens: { [M]: { ui: 100 } } }), sell("s", T + H, W, M, 100, 5)]);
  const [r] = pnl.rounds;
  assert.equal(r.status, "UNKNOWN");
  assert.equal(r.pnl, null);
  assert.deepEqual(r.unknownReasons, ["transfer_in_unknown_cost", "sold_unknown_cost_lot"]);
  assert.equal(profile.totals.sol.realized, 0);
  assert.equal(profile.winRate.n, 0);
});

test("a sale beyond the known inventory (bought before the window) is UNKNOWN", () => {
  const { pnl } = run([sell("s", T, W, M, 10, 3)]);
  assert.equal(pnl.rounds[0].status, "UNKNOWN");
  assert.deepEqual(pnl.rounds[0].unknownReasons, ["sell_without_known_buy"]);
  assert.equal(pnl.rounds[0].proceeds, null);
});

test("moving tokens out, or an undecodable route, makes the position UNKNOWN", () => {
  const out = run([buy("b", T, W, M, 10, 1), tx({ sig: "o", time: T + H, wallet: W, signer: true, programs: ["11111111111111111111111111111111"], tokens: { [M]: { ui: -10 } } })]);
  assert.deepEqual(out.pnl.rounds[0].unknownReasons, ["transferred_out"]);
  const route = run([buy("b", T, W, M, 10, 1), tx({ sig: "r", time: T + H, wallet: W, sol: 0.4, tokens: { [M]: { ui: -4 }, [addr(41)]: { ui: 2 } } }), sell("s", T + 2 * H, W, M, 6, 1)]);
  assert.equal(route.pnl.rounds.find((r) => r.mint === M)?.status, "UNKNOWN");
  assert.ok(route.pnl.rounds.find((r) => r.mint === M)?.unknownReasons.includes("undecodable_tx"));
});

test("USD and SOL are never mixed: a SOL buy sold for USDC is UNKNOWN; pure USD rounds stay in USD", () => {
  const mixed = run([buy("b", T, W, M, 10, 1), tx({ sig: "s", time: T + H, wallet: W, sol: -0.00001, tokens: { [M]: { ui: -10 }, [USDC_MINT]: { ui: 200 } } })]);
  assert.deepEqual(mixed.pnl.rounds[0].unknownReasons, ["mixed_quote"]);
  const usd = run([tx({ sig: "b", time: T, wallet: W, tokens: { [M]: { ui: 10 }, [USDC_MINT]: { ui: -100 } } }), tx({ sig: "s", time: T + H, wallet: W, tokens: { [M]: { ui: -10 }, [USDC_MINT]: { ui: 130 } } })]);
  assert.equal(usd.pnl.rounds[0].quote, "USD");
  assert.ok(closeTo(usd.pnl.rounds[0].pnl, 30));
  assert.equal(usd.profile.totals.sol.rounds, 0);
  assert.ok(closeTo(usd.profile.totals.usd.realized, 30));
  assert.ok(usd.profile.caveats.some((c) => /USD/.test(c)));
});

test("incomplete history: clean-looking rounds are PROVISIONAL and kept out of the win rate", () => {
  const { pnl, profile } = run([buy("b", T, W, M, 10, 1), sell("s", T + H, W, M, 10, 3)], { complete: false, oldestTime: T });
  assert.equal(pnl.rounds[0].status, "PROVISIONAL");
  assert.ok(closeTo(pnl.rounds[0].pnl, 2)); // shown, but not counted
  assert.equal(profile.winRate.n, 0);
  assert.equal(profile.totals.sol.rounds, 0);
  assert.ok(profile.caveats.some((c) => /incomplet/i.test(c)));
});

test("failed transactions cost fees but belong to no position", () => {
  const { pnl, profile } = run([tx({ sig: "f", time: T, wallet: W, sol: -0.000005, failed: true }), buy("b", T + H, W, M, 1, 1), sell("s", T + 2 * H, W, M, 1, 1)]);
  assert.ok(closeTo(pnl.failedFeeSol, 0.000005));
  assert.ok(closeTo(pnl.rounds[0].pnl, 0));
  assert.ok(closeTo(profile.failedFeeSol, 0.000005));
});

test("win rate: Wilson interval, flat rounds are not wins, and the sample threshold is configurable", () => {
  const [lo, hi] = wilson(10, 20)!;
  assert.ok(closeTo(lo, 0.2993, 1e-3) && closeTo(hi, 0.7007, 1e-3));
  assert.equal(wilson(0, 0), null);
  const [l0, h0] = wilson(0, 5)!;
  assert.equal(l0, 0);
  assert.ok(h0 > 0.3); // 0/5 does not prove a 0 % rate

  const txs: HistoryTx[] = [];
  const outcomes = [2, 0.5, 1, 3, 0.4]; // wins, loss, flat, win, loss
  outcomes.forEach((m, i) => {
    const mint = addr(50 + i);
    txs.push(buy(`b${i}`, T + i * 2 * H, W, mint, 10, 1), sell(`s${i}`, T + i * 2 * H + H, W, mint, 10, m));
  });
  const strict = run(txs).profile.winRate;
  assert.deepEqual([strict.n, strict.wins, strict.losses, strict.flat, strict.sample], [5, 2, 2, 1, "insufficient"]);
  assert.equal(strict.rate, 0.4);
  const relaxed = run(txs, complete, { thresholds: { ...DEFAULT_THRESHOLDS, minClosedPositions: 5 }, tipAccounts: [] }).profile.winRate;
  assert.equal(relaxed.sample, "sufficient");
  const exactly19 = (n: number) => { const p = run(Array.from({ length: n }, (_, i) => [buy(`b${i}`, T + i * 2 * H, W, addr(60 + (i % 100)), 1, 1), sell(`s${i}`, T + i * 2 * H + H, W, addr(60 + (i % 100)), 1, 2)]).flat()).profile.winRate; return p.sample; };
  assert.equal(exactly19(19), "insufficient");
  assert.equal(exactly19(20), "sufficient");
});

test("consistency measures: drawdown, loss streak, concentration, weekly breakdown", () => {
  const pnls = [1, -2, 3, -1, -1]; // cumulative 1,-1,2,1,0
  const txs: HistoryTx[] = [];
  pnls.forEach((p, i) => {
    const mint = addr(70 + i);
    const t0 = T + i * 4 * 24 * H; // 4 days apart → 2 weeks
    txs.push(buy(`b${i}`, t0, W, mint, 10, 3), sell(`s${i}`, t0 + H, W, mint, 10, 3 + p));
  });
  const c = run(txs).profile.consistency;
  assert.equal(c.n, 5);
  assert.ok(closeTo(c.totalPnlSol, 0));
  assert.ok(closeTo(c.maxDrawdownSol, 2));
  assert.equal(c.longestLossStreak, 2);
  assert.ok(closeTo(c.bestShareOfGrossProfit, 0.75)); // 3 of gross 4
  assert.ok(closeTo(c.pnlWithoutBestSol, -3));
  assert.ok(c.activeWeeks >= 2 && c.profitableWeeks <= c.activeWeeks);
  assert.ok(closeTo(c.medianHoldSeconds, 3600));
});

test("one known round gives no regularity numbers (UNKNOWN, not 0)", () => {
  const c = run([buy("b", T, W, M, 1, 1), sell("s", T + H, W, M, 1, 2)]).profile.consistency;
  assert.equal(c.n, 1);
  assert.equal(c.pnlWithoutBestSol, null);
});

test("conservation: total realized PnL equals proceeds minus cost over many random round trips", () => {
  const rnd = mulberry32(7);
  const txs: HistoryTx[] = [];
  let cost = 0;
  let proceeds = 0;
  for (let i = 0; i < 300; i++) {
    const mint = addr(100 + (i % 120));
    const c = Math.round((0.1 + rnd()) * 1024) / 1024;
    const p = Math.round(rnd() * 4 * 1024) / 1024;
    cost += c;
    proceeds += p;
    const t0 = T + i * 3 * H;
    txs.push(buy(`b${i}`, t0, W, mint, 1000, c), sell(`s${i}`, t0 + H, W, mint, 1000, p));
  }
  const { profile } = run(txs);
  assert.equal(profile.counts.known, 300);
  assert.ok(closeTo(profile.totals.sol.realized, proceeds - cost, 1e-6));
  assert.ok(closeTo(profile.totals.sol.feesSol, 600 * 0.000005, 1e-9));
  assert.ok(closeTo(profile.totals.sol.tradingPnl, proceeds - cost + 600 * 0.000005, 1e-6)); // before fees
});

test("the demo wallet: every awkward case stays unknown, the clean ones are counted", () => {
  const { pnl, profile } = run(demoWalletTxs(W));
  assert.equal(profile.counts.unknown, 2);
  assert.equal(profile.counts.partial, 1);
  assert.equal(profile.counts.known, 25);
  assert.equal(profile.totals.sol.rounds, 24);
  assert.equal(profile.totals.usd.rounds, 1);
  assert.equal(profile.open.length, 3);
  assert.ok(pnl.rounds.filter((r) => r.status === "UNKNOWN").every((r) => r.pnl === null));
  assert.equal(profile.winRate.sample, "sufficient");
});

test("the profile event validates against the contract and is idempotent", () => {
  const { pnl, profile } = run(demoWalletTxs(W));
  const e1 = profileEvent(profile, pnl, { now: 1, criteriaVersion: "c", simulated: true });
  const e2 = profileEvent(profile, pnl, { now: 2, criteriaVersion: "c", simulated: true });
  assert.equal(e1.eventId, e2.eventId);
  assert.equal(validateEvent({ schemaVersion: "smart-money.event/1", ...e1, seq: 1, source: "smart-money-tracker", notAdvice: true }).ok, true);
  assert.equal(e1.dataQuality.level, "MEDIUM"); // one PARTIAL round caps the quality
  assert.ok(e1.dataQuality.unknowns.includes("partial_rent_unattributed"));
  assert.ok(e1.dataQuality.unknowns.includes("unknown:sell_without_known_buy"));
  const prov = profileEvent(run(demoWalletTxs(W), { complete: false, oldestTime: null }).profile, pnl, { now: 1, criteriaVersion: "c", simulated: true });
  assert.equal(prov.dataQuality.level, "LOW");
});
