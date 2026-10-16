import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS } from "../../src/smart-money/config.ts";
import { buildLedger } from "../../src/smart-money/ledger/build.ts";
import { detectRent } from "../../src/smart-money/ledger/rent.ts";
import { analyzeWallet } from "../../src/smart-money/pnl/profile.ts";
import { ATA_PROGRAM, DEMO_START, DEX_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS, USDC_MINT, addr, buy, buyCreatingAta, mulberry32, sell, sellClosingAta, tx } from "../../src/smart-money/demo/fixtures.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import type { TradeEntry, TransferEntry } from "../../src/smart-money/ledger/types.ts";
import { closeTo } from "./helpers.ts";

const W = addr(11);
const M = addr(40);
const T = DEMO_START;
const H = 3_600_000;
const RENT = TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9;
const complete = { complete: true, oldestTime: null };
const analyze = (txs: HistoryTx[], cov: { complete: boolean; oldestTime: number | null } = complete, tipAccounts: string[] = []) => analyzeWallet(W, txs, { coverage: cov, config: { thresholds: DEFAULT_THRESHOLDS, tipAccounts } });

test("ATA creation on a buy: the deposit is rent, not trading cost", () => {
  const e = buildLedger(W, [buyCreatingAta("b", T, W, M, 1000, 1)]).entries[0] as TradeEntry;
  assert.equal(e.rentStatus, "identified");
  assert.equal(e.rentDepositLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.equal(e.rentRefundLamports, 0);
  assert.ok(closeTo(e.quote.amount, 1 - 0.000005, 1e-9)); // 1 SOL of trading, fee out
  assert.ok(closeTo(e.allInSol, 1 + RENT, 1e-9)); // what the balance really moved by
});

test("ATA closure on a sell: the refund is rent, not sale proceeds", () => {
  const e = buildLedger(W, [sellClosingAta("s", T, W, M, 1000, 2)]).entries[0] as TradeEntry;
  assert.equal(e.rentStatus, "identified");
  assert.equal(e.rentRefundLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.ok(closeTo(e.quote.amount, 2 + 0.000005, 1e-9));
});

test("create + close: PnL is the trading result; the rent comes back and nets to zero", () => {
  const { pnl, profile } = analyze([buyCreatingAta("b", T, W, M, 1000, 1), sellClosingAta("s", T + H, W, M, 1000, 3)]);
  const [r] = pnl.rounds;
  assert.equal(r.status, "KNOWN");
  assert.ok(closeTo(r.pnl, 2)); // 3 − 1, not 3 − 1 − rent + rent drift
  assert.ok(closeTo(r.rentDepositedSol, RENT) && closeTo(r.rentRecoveredSol, RENT));
  assert.ok(closeTo(profile.costs.rentNetLockedSol, 0, 1e-12));
  assert.ok(closeTo(profile.costs.feesSol, 0.00001));
});

test("without separating rent the deposit would have looked like a loss: rent is excluded from the result", () => {
  // Buy 1 → sell 1 (break-even trade). Rent is paid on the way in and only partly... fully refunded: net PnL must be ~0, not −rent.
  const { profile } = analyze([buyCreatingAta("b", T, W, M, 1000, 1), sellClosingAta("s", T + H, W, M, 1000, 1)]);
  assert.ok(closeTo(profile.totals.sol.realized, 0, 1e-9));
  const open = analyze([buyCreatingAta("b", T, W, M, 1000, 1)]);
  assert.ok(closeTo(open.profile.costs.rentNetLockedSol, RENT, 1e-12)); // deposited, not yet recovered: shown apart
  assert.equal(open.profile.totals.sol.rounds, 0);
});

test("create-idempotent on an existing account (ATA program, no lamport change) is NOT a false alarm", () => {
  const t = tx({ sig: "i", time: T, wallet: W, sol: -1, tokens: { [M]: { ui: 10 } }, programs: [DEX_PROGRAM, ATA_PROGRAM] });
  const e = buildLedger(W, [t]).entries[0] as TradeEntry;
  assert.equal(e.rentStatus, "none");
  assert.deepEqual(e.flags, ["ata_program_present"]);
});

test("a Token-2022-sized rent (not the standard amount) is UNCERTAIN: the round is PARTIAL, not a misleading PnL", () => {
  const t2022 = buy("b", T, W, M, 1000, 1);
  const odd = { ...t2022, programIds: [DEX_PROGRAM, ATA_PROGRAM], lamportDeltas: { ...t2022.lamportDeltas, [addr(242)]: 2_157_600 } };
  assert.equal(detectRent(odd, W).status, "uncertain");
  const { pnl, profile } = analyze([odd, sell("s", T + H, W, M, 1000, 2)]);
  assert.equal(pnl.rounds[0].status, "PARTIAL");
  assert.deepEqual(pnl.rounds[0].partialReasons, ["rent_unattributed"]);
  assert.ok(pnl.rounds[0].pnl !== null); // approximate all-in value stays visible…
  assert.equal(profile.counts.partial, 1);
  assert.equal(profile.winRate.n, 0); // …but is kept out of the statistics
  assert.equal(profile.totals.sol.rounds, 0);
  assert.ok(profile.caveats.some((c) => /PARTIELLE/.test(c)));
});

test("rent in a transaction another party also signed cannot be attributed to the wallet: UNCERTAIN", () => {
  const coSigned = { ...buyCreatingAta("b", T, W, M, 1000, 1), signers: [W, addr(251)] };
  const r = detectRent(coSigned, W);
  assert.deepEqual([r.status, r.depositLamports], ["uncertain", 0]);
  const enhanced = { ...buyCreatingAta("b2", T, W, M, 1000, 1), signersComplete: false };
  assert.equal(detectRent(enhanced, W).status, "uncertain");
  const sponsored = { ...buyCreatingAta("b3", T, W, M, 1000, 1), feePayer: addr(252) };
  assert.equal(detectRent(sponsored, W).status, "uncertain");
});

test("PARTIAL takes precedence over PROVISIONAL; UNKNOWN takes precedence over both", () => {
  const odd = (() => { const t = buy("b", T, W, M, 1000, 1); return { ...t, programIds: [DEX_PROGRAM, ATA_PROGRAM], lamportDeltas: { ...t.lamportDeltas, [addr(242)]: 2_157_600 } }; })();
  const incomplete = { complete: false, oldestTime: null };
  assert.equal(analyze([odd, sell("s", T + H, W, M, 1000, 2)], incomplete).pnl.rounds[0].status, "PARTIAL");
  assert.equal(analyze([odd, sell("s", T + H, W, M, 5000, 2)], incomplete).pnl.rounds[0].status, "UNKNOWN");
});

test("USDC swap with ATA creation: USD amounts untouched, SOL rent kept out of the USD price and the unconverted fee", () => {
  const t = tx({ sig: "u", time: T, wallet: W, sol: -(RENT + 0.000005), tokens: { [M]: { ui: 10 }, [USDC_MINT]: { ui: -100 } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [addr(240)]: TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const e = buildLedger(W, [t]).entries[0] as TradeEntry;
  assert.deepEqual(e.quote, { asset: "USD", amount: 100 });
  assert.equal(e.rentDepositLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.ok(closeTo(e.unconvertedFeeSol, 0.000005, 1e-12)); // fee only, no rent
  const back = tx({ sig: "u2", time: T + H, wallet: W, sol: RENT - 0.000005, tokens: { [M]: { ui: -10 }, [USDC_MINT]: { ui: 140 } }, extraLamports: { [addr(240)]: -TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const { pnl, profile } = analyze([t, back]);
  assert.equal(pnl.rounds[0].quote, "USD");
  assert.ok(closeTo(pnl.rounds[0].pnl, 40));
  assert.equal(profile.totals.sol.rounds, 0);
});

test("a SOL trade with identified rent is a trade even when small; the same size with unseparated rent stays a transfer", () => {
  const small = buildLedger(W, [buyCreatingAta("b", T, W, M, 5, 0.0008)]).entries[0];
  assert.equal(small.kind, "trade");
  const unseparated = tx({ sig: "n", time: T, wallet: W, sol: -(RENT + 0.0008), tokens: { [M]: { ui: 5 } } }); // same SOL movement, no rent account visible
  assert.equal(buildLedger(W, [unseparated]).entries[0].kind, "transfer");
});

test("transfers: a received token whose account the wallet had to create keeps the rent apart, price stays UNKNOWN", () => {
  const t = tx({ sig: "t", time: T, wallet: W, sol: -(RENT + 0.000005), tokens: { [M]: { ui: 100 } }, programs: [ATA_PROGRAM, "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], extraLamports: { [addr(240)]: TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const e = buildLedger(W, [t]).entries[0] as TransferEntry;
  assert.equal(e.kind, "transfer");
  assert.equal(e.rentDepositLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  const { pnl } = analyze([t, sell("s", T + H, W, M, 100, 5)]);
  assert.equal(pnl.rounds[0].status, "UNKNOWN");
  assert.equal(pnl.rounds[0].pnl, null);
});

test("account cleanup with no token movement: the refund is counted at wallet level, tied to no position", () => {
  const cleanup = tx({ sig: "c", time: T, wallet: W, sol: RENT * 3 - 0.000005, extraLamports: { [addr(240)]: -TOKEN_ACCOUNT_RENT_LAMPORTS, [addr(241)]: -TOKEN_ACCOUNT_RENT_LAMPORTS, [addr(242)]: -TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const l = buildLedger(W, [cleanup]);
  assert.equal(l.entries.length, 0);
  assert.equal(l.otherCosts.rentRefundLamports, 3 * TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.equal(l.otherCosts.feeLamports, 5000);
  const { profile } = analyze([cleanup]);
  assert.ok(closeTo(profile.costs.rentRecoveredSol, 3 * RENT, 1e-12));
});

test("incomplete history with rent: still PROVISIONAL, rent accounting unaffected", () => {
  const { pnl, profile } = analyze([buyCreatingAta("b", T, W, M, 1000, 1), sellClosingAta("s", T + H, W, M, 1000, 2)], { complete: false, oldestTime: T });
  assert.equal(pnl.rounds[0].status, "PROVISIONAL");
  assert.ok(closeTo(pnl.rounds[0].pnl, 1));
  assert.equal(profile.winRate.n, 0);
  assert.ok(closeTo(profile.costs.rentDepositedSol, RENT, 1e-12));
});

test("tips configured: separated from the trading cost, deducted once in the net result", () => {
  const TIP = addr(77);
  const b = tx({ sig: "b", time: T, wallet: W, sol: -(1 + 0.001), tokens: { [M]: { ui: 10 } }, extraLamports: { [TIP]: 1_000_000 } });
  const s = sell("s", T + H, W, M, 10, 2);
  const withTip = analyze([b, s], complete, [TIP]).pnl.rounds[0];
  assert.ok(closeTo(withTip.tipsSol, 0.001, 1e-12));
  assert.ok(closeTo(withTip.cost, 1 - 0.000005, 1e-9));
  assert.ok(closeTo(withTip.pnl, 2 - 1.001, 1e-9)); // the tip really cost 0.001
  const noTipConfig = analyze([b, s]).pnl.rounds[0];
  assert.equal(noTipConfig.tipsSol, 0);
  assert.ok(closeTo(noTipConfig.pnl, 2 - 1.001, 1e-9)); // same result: configuring tips changes the split, not the answer
});

test("conservation with rent: net PnL = Σ all-in sells − Σ all-in buys + net identified rent, over random mixed trades", () => {
  const rnd = mulberry32(99);
  const txs: HistoryTx[] = [];
  for (let i = 0; i < 200; i++) {
    const mint = addr(100 + (i % 120));
    const c = Math.round((0.1 + rnd()) * 1024) / 1024;
    const p = Math.round(rnd() * 4 * 1024) / 1024;
    const t0 = T + i * 3 * H;
    const create = rnd() < 0.5;
    const close = rnd() < 0.5;
    const acct = addr(130 + (i % 100));
    txs.push((create ? buyCreatingAta : buy)(`b${i}`, t0, W, mint, 1000, c, acct), (close ? sellClosingAta : sell)(`s${i}`, t0 + H, W, mint, 1000, p, acct));
  }
  const ledger = buildLedger(W, txs);
  const { profile } = analyze(txs);
  let allIn = 0;
  let rentNet = 0;
  for (const e of ledger.entries as TradeEntry[]) {
    allIn += e.side === "sell" ? e.allInSol! : -e.allInSol!;
    rentNet += (e.rentDepositLamports - e.rentRefundLamports) / 1e9;
  }
  assert.equal(profile.counts.known, 200);
  assert.ok(closeTo(profile.totals.sol.realized, allIn + rentNet, 1e-6));
});
