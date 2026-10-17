import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS } from "../../src/smart-money/config.ts";
import { ATA_PROGRAM, DEMO_START, DEX_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS, USDC_MINT, WSOL_MINT, addr, buy, buyCreatingAta, mulberry32, sell, sellClosingAta, swapTx, tx, POOL } from "../../src/smart-money/demo/fixtures.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import { buildLedger } from "../../src/smart-money/ledger/build.ts";
import { assessRent } from "../../src/smart-money/ledger/rent.ts";
import type { TradeEntry, TransferEntry } from "../../src/smart-money/ledger/types.ts";
import { analyzeWallet } from "../../src/smart-money/pnl/profile.ts";
import { deriveAta, TOKEN_2022_PROGRAM_ID } from "../../src/smart-money/solana/pda.ts";
import { closeTo } from "./helpers.ts";

const W = addr(11);
const M = addr(40);
const T = DEMO_START;
const H = 3_600_000;
const RENT = TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9;
const complete = { complete: true, oldestTime: null };
const analyze = (txs: HistoryTx[], cov: { complete: boolean; oldestTime: number | null } = complete, tipAccounts: string[] = []) => analyzeWallet(W, txs, { coverage: cov, config: { thresholds: DEFAULT_THRESHOLDS, tipAccounts } });

test("ATA creation on a buy: the deposit is rent, not trading cost, and it is the wallet's own derived token account", () => {
  const t = buyCreatingAta("b", T, W, M, 1000, 1);
  const a = assessRent(t, W);
  assert.equal(a.status, "identified");
  assert.equal(a.funder, "wallet");
  assert.equal(a.created[0].account, deriveAta(W, M));
  assert.equal(a.depositLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  const e = buildLedger(W, [t]).entries[0] as TradeEntry;
  assert.ok(closeTo(e.quote.amount, 1 - 0.000005, 1e-9)); // 1 SOL of trading, network fee out
  assert.ok(closeTo(e.allInSol, 1 + RENT, 1e-9));
});

test("ATA closure on a sell: the refund is rent, not sale proceeds", () => {
  const e = buildLedger(W, [sellClosingAta("s", T, W, M, 1000, 2)]).entries[0] as TradeEntry;
  assert.equal(e.rentStatus, "identified");
  assert.equal(e.rentRefundLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.ok(closeTo(e.quote.amount, 2 + 0.000005, 1e-9));
});

test("create + close: PnL is the trading result; the rent comes back and nets to zero; unrecovered rent is shown apart", () => {
  const { pnl, profile } = analyze([buyCreatingAta("b", T, W, M, 1000, 1), sellClosingAta("s", T + H, W, M, 1000, 3)]);
  const [r] = pnl.rounds;
  assert.equal(r.status, "KNOWN");
  assert.ok(closeTo(r.pnl, 2));
  assert.ok(closeTo(r.rentDepositedSol, RENT) && closeTo(r.rentRecoveredSol, RENT));
  assert.ok(closeTo(profile.costs.rentNetLockedSol, 0, 1e-12));
  const open = analyze([buyCreatingAta("b", T, W, M, 1000, 1)]);
  assert.ok(closeTo(open.profile.costs.rentNetLockedSol, RENT, 1e-12));
  assert.equal(open.profile.totals.sol.rounds, 0);
  const flat = analyze([buyCreatingAta("b", T, W, M, 1000, 1), sellClosingAta("s", T + H, W, M, 1000, 1)]);
  assert.ok(closeTo(flat.profile.totals.sol.realized, 0, 1e-9)); // break-even trade: no phantom rent loss
});

test("a Token-2022 account of non-standard size is proven by its derived address, and its own delta is the rent", () => {
  const t = swapTx({ sig: "t22", time: T, wallet: W, mint: M, side: "buy", ui: 10, tradeSol: 1, createAta: true, token2022: true, rentLamports: 2_157_600 });
  const a = assessRent(t, W);
  assert.equal(a.status, "identified");
  assert.deepEqual([a.created[0].program, a.depositLamports], ["token2022", 2_157_600]);
  assert.equal(a.created[0].account, deriveAta(W, M, TOKEN_2022_PROGRAM_ID));
});

test("NO numeric range: a lamport delta that merely looks like a rent is never a rent", () => {
  for (const delta of [890_880, 1_000_000, 2_039_279, 2_157_600, 2_500_000, 2_999_999, 3_000_000]) {
    const t = tx({ sig: `r${delta}`, time: T, wallet: W, sol: -1, tokens: { [M]: { ui: 10 } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [addr(150)]: delta } });
    assert.equal(assessRent(t, W).status, "none", String(delta));
  }
  // The exact standard amount on an account that is NOT the wallet's token account is a LEAD: uncertain, never identified.
  const exact = tx({ sig: "exact", time: T, wallet: W, sol: -1, tokens: { [M]: { ui: 10 } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [addr(150)]: TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const a = assessRent(exact, W);
  assert.equal(a.status, "uncertain");
  assert.deepEqual(a.reasons, ["standard_size_account_not_wallet_ata"]);
  assert.equal(a.depositLamports, 0);
  // …unless the account is a pool (it owns tokens that moved), or no token / ATA program ran, or it signed.
  const pool = { ...exact, tokenDeltas: { ...exact.tokenDeltas, [addr(150)]: { [M]: { raw: "-10000000", decimals: 6 } } } };
  assert.equal(assessRent(pool, W).status, "none");
  assert.equal(assessRent({ ...exact, programIds: [DEX_PROGRAM] }, W).status, "none");
});

test("the micro-trade false positive is gone: a pool's SOL is a counterparty, not a rent", () => {
  const micro = swapTx({ sig: "m", time: T, wallet: W, mint: M, side: "buy", ui: 100, tradeSol: 0.0025, programs: [DEX_PROGRAM, ATA_PROGRAM] });
  assert.equal(assessRent(micro, W).status, "none");
  const e = buildLedger(W, [micro]).entries[0] as TradeEntry;
  assert.equal(e.kind, "trade");
  assert.equal(e.swapProof, "counterparty_payment");
  assert.ok(e.reasons!.includes("micro_trade_kept"));
});

test("who paid: another signer able to fund the deposit makes it unproven; a co-signer that nets nothing does not", () => {
  const temp = swapTx({ sig: "temp", time: T, wallet: W, mint: M, side: "buy", ui: 10, tradeSol: 0.5, createAta: true, signers: [W, addr(250)] });
  assert.equal(assessRent(temp, W).status, "identified");
  assert.equal(assessRent(temp, W).funder, "wallet");

  const sponsor = swapTx({ sig: "sp", time: T, wallet: W, mint: M, side: "buy", ui: 10, tradeSol: 0.5, createAta: true, signers: [W, addr(252)], rentPayer: addr(252) });
  const a = assessRent(sponsor, W);
  assert.deepEqual([a.status, a.funder, a.reasons], ["uncertain", "unknown", ["funder_ambiguous"]]);
  assert.equal(a.depositLamports, 0);

  const enhanced = { ...swapTx({ sig: "en", time: T, wallet: W, mint: M, side: "buy", ui: 10, tradeSol: 0.5, createAta: true }), signersComplete: false };
  assert.deepEqual(assessRent(enhanced, W).reasons, ["incomplete_signers"]);
});

test("a wallet that did not sign paid nothing: an ATA created for it by a sender is a third-party deposit, outside its cash flow", () => {
  const sender = addr(77);
  const airdrop: HistoryTx = {
    signature: "air", slot: 1, time: T, failed: false, feePayer: sender, signers: [sender], signersComplete: true, fee: 5000,
    lamportDeltas: { [sender]: -(TOKEN_ACCOUNT_RENT_LAMPORTS + 5000), [deriveAta(W, M)]: TOKEN_ACCOUNT_RENT_LAMPORTS },
    tokenDeltas: { [W]: { [M]: { raw: "1000000", decimals: 6 } }, [sender]: { [M]: { raw: "-1000000", decimals: 6 } } },
    programIds: [ATA_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], origin: "helius-gtfa", providerHint: null,
  };
  const a = assessRent(airdrop, W);
  assert.deepEqual([a.status, a.funder, a.depositLamports, a.thirdPartyDepositLamports], ["identified", "third_party", 0, TOKEN_ACCOUNT_RENT_LAMPORTS]);
  const e = buildLedger(W, [airdrop]).entries[0] as TransferEntry;
  assert.equal(e.kind, "transfer");
  assert.equal(e.thirdPartyRentLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.equal(e.rentDepositLamports, 0);
});

test("closing: the refund goes to the wallet unless another signer received an equivalent amount", () => {
  const ok = swapTx({ sig: "c1", time: T, wallet: W, mint: M, side: "sell", ui: 10, tradeSol: 1, closeAta: true });
  assert.equal(assessRent(ok, W).refundLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  const other = addr(251);
  const diverted = swapTx({ sig: "c2", time: T, wallet: W, mint: M, side: "sell", ui: 10, tradeSol: 1, closeAta: true, signers: [W, other] });
  diverted.lamportDeltas[other] = TOKEN_ACCOUNT_RENT_LAMPORTS; // the other signer got a rent-sized amount
  const a = assessRent(diverted, W);
  assert.deepEqual([a.status, a.reasons, a.refundLamports], ["uncertain", ["refund_destination_ambiguous"], 0]);
});

test("native SOL accounts: topping up the wrapped-SOL account is not a rent; creating it with a balance is, minus the balance", () => {
  const wsolAta = deriveAta(W, WSOL_MINT);
  const topUp = tx({ sig: "tu", time: T, wallet: W, sol: -1.000005, tokens: { [WSOL_MINT]: { ui: 1, decimals: 9 }, [M]: { ui: 5 } }, extraLamports: { [wsolAta]: 1_000_000_000 } });
  assert.equal(assessRent(topUp, W).status, "none");
  const create = tx({ sig: "cr", time: T, wallet: W, sol: -(1 + RENT + 0.000005), tokens: { [WSOL_MINT]: { ui: 1, decimals: 9 }, [M]: { ui: 5 } }, extraLamports: { [wsolAta]: 1_000_000_000 + TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const a = assessRent(create, W);
  assert.equal(a.status, "identified");
  assert.equal(a.depositLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
});

test("invariants over a grid: uncertain ⇔ a named reason; nothing is attributed without a proof", () => {
  const ata = deriveAta(W, M);
  let n = 0;
  for (const signers of [[W], [W, addr(250)], [addr(252), W]]) for (const feePayer of [W, addr(252)]) for (const complete of [true, false]) for (const create of [false, true]) for (const close of [false, true]) for (const foreign of [false, true]) for (const prog of [true, false]) {
    const extra: Record<string, number> = {};
    if (create) extra[ata] = TOKEN_ACCOUNT_RENT_LAMPORTS;
    if (close && !create) extra[ata] = -TOKEN_ACCOUNT_RENT_LAMPORTS;
    if (foreign) extra[addr(213)] = TOKEN_ACCOUNT_RENT_LAMPORTS;
    const t = { ...tx({ sig: "v", time: T, wallet: W, sol: -1, tokens: { [M]: { ui: 1 } }, programs: prog ? [DEX_PROGRAM, ATA_PROGRAM] : [DEX_PROGRAM], extraLamports: extra }), signers, feePayer, signersComplete: complete };
    const a = assessRent(t, W);
    n++;
    assert.equal(a.status === "uncertain", a.reasons.length > 0);
    if (a.status === "none") assert.ok(a.created.length === 0 && a.closed.length === 0 && a.unattributed.length === 0);
    if (a.status === "identified") assert.ok(a.created.length > 0 || a.closed.length > 0);
    assert.ok(a.depositLamports <= a.created.reduce((s, c) => s + c.rentLamports, 0));
    if (a.depositLamports > 0) assert.ok(complete && signers.includes(W));
    assert.ok(a.thirdPartyDepositLamports === 0 || !signers.includes(W));
  }
  assert.equal(n, 3 * 2 * 2 * 2 * 2 * 2 * 2);
});

test("USDC swap with ATA creation: USD amounts untouched, the rent kept out of the USD price and of the unconverted fee", () => {
  const t = tx({ sig: "u", time: T, wallet: W, sol: -(RENT + 0.000005), tokens: { [M]: { ui: 10 }, [USDC_MINT]: { ui: -100 } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [deriveAta(W, M)]: TOKEN_ACCOUNT_RENT_LAMPORTS } });
  const e = buildLedger(W, [t]).entries[0] as TradeEntry;
  assert.deepEqual(e.quote, { asset: "USD", amount: 100 });
  assert.equal(e.rentDepositLamports, TOKEN_ACCOUNT_RENT_LAMPORTS);
  assert.ok(closeTo(e.unconvertedFeeSol, 0.000005, 1e-12));
});

test("tips configured: separated from the trading cost, deducted once in the net result", () => {
  const TIP = addr(77);
  const b = tx({ sig: "b", time: T, wallet: W, sol: -(1 + 0.001), tokens: { [M]: { ui: 10 } }, extraLamports: { [TIP]: 1_000_000 } });
  const withTip = analyze([b, sell("s", T + H, W, M, 10, 2)], complete, [TIP]).pnl.rounds[0];
  assert.ok(closeTo(withTip.tipsSol, 0.001, 1e-12));
  assert.ok(closeTo(withTip.cost, 1 - 0.000005, 1e-9));
  assert.ok(closeTo(withTip.pnl, 2 - 1.001, 1e-9));
  assert.ok(closeTo(analyze([b, sell("s", T + H, W, M, 10, 2)]).pnl.rounds[0].pnl, 2 - 1.001, 1e-9)); // same answer, different split
});

test("incomplete history with proven rent: still PROVISIONAL, rent accounting unaffected", () => {
  const { pnl, profile } = analyze([buyCreatingAta("b", T, W, M, 1000, 1), sellClosingAta("s", T + H, W, M, 1000, 2)], { complete: false, oldestTime: T });
  assert.equal(pnl.rounds[0].status, "PROVISIONAL");
  assert.ok(closeTo(pnl.rounds[0].pnl, 1));
  assert.equal(profile.winRate.n, 0);
});

test("conservation with rent: net PnL = Σ all-in sells − Σ all-in buys + net proven rent, over random mixed trades", () => {
  const rnd = mulberry32(99);
  const txs: HistoryTx[] = [];
  for (let i = 0; i < 200; i++) {
    const mint = addr(100 + (i % 120));
    const c = Math.round((0.1 + rnd()) * 1024) / 1024;
    const p = Math.round(rnd() * 4 * 1024) / 1024;
    const t0 = T + i * 3 * H;
    const create = rnd() < 0.5;
    const close = rnd() < 0.5;
    txs.push((create ? buyCreatingAta : buy)(`b${i}`, t0, W, mint, 1000, c), (close ? sellClosingAta : sell)(`s${i}`, t0 + H, W, mint, 1000, p));
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

test("a pool is always apart from the rent: the helper's counterparty is the token owner that moved the other way", () => {
  const t = swapTx({ sig: "p", time: T, wallet: W, mint: M, side: "buy", ui: 10, tradeSol: 0.3, createAta: true });
  assert.ok(POOL in t.tokenDeltas && t.tokenDeltas[POOL][M].raw.startsWith("-"));
  assert.ok(closeTo(t.lamportDeltas[POOL] / 1e9, 0.3));
});
