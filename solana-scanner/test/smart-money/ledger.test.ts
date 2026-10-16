import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLedger } from "../../src/smart-money/ledger/build.ts";
import { USDC_MINT, addr, buy, sell, tx, TOKEN_PROGRAM, SYSTEM_PROGRAM, WSOL_MINT } from "../../src/smart-money/demo/fixtures.ts";
import type { TradeEntry, TransferEntry, UndecodableEntry } from "../../src/smart-money/ledger/types.ts";

const W = addr(11);
const M = addr(40);
const T = 1_700_000_000_000;

test("a SOL buy and sell become trades priced on the TRADING flow; the network fee is separated and recorded", () => {
  const l = buildLedger(W, [buy("b", T, W, M, 1000, 1), sell("s", T + 1000, W, M, 1000, 2)]);
  const [b, s] = l.entries as TradeEntry[];
  assert.equal(b.kind, "trade");
  assert.equal(b.side, "buy");
  assert.ok(Math.abs(b.quote.amount - 0.999995) < 1e-12); // 1 SOL left the wallet, 5000 lamports of it were the fee
  assert.equal(b.allInSol, 1);
  assert.equal(b.feeLamports, 5000);
  assert.equal(s.side, "sell");
  assert.ok(Math.abs(s.quote.amount - 2.000005) < 1e-12);
  assert.equal(s.allInSol, 2);
  assert.equal(b.tokenAmount, 1000);
});

test("wrapped SOL counts as SOL (swap through a WSOL account)", () => {
  const l = buildLedger(W, [tx({ sig: "w", time: T, wallet: W, sol: -0.0001, tokens: { [M]: { ui: 50 }, [WSOL_MINT]: { ui: -1, decimals: 9 } } })]);
  const e = l.entries[0] as TradeEntry;
  assert.equal(e.kind, "trade");
  assert.equal(e.quote.asset, "SOL");
  assert.ok(Math.abs(e.quote.amount - 1.000095) < 1e-9);
});

test("a USDC swap is a USD trade; the SOL fee/rent is NOT converted into the price", () => {
  const l = buildLedger(W, [tx({ sig: "u", time: T, wallet: W, sol: -0.00204, tokens: { [M]: { ui: 10 }, [USDC_MINT]: { ui: -25 } } })]);
  const e = l.entries[0] as TradeEntry;
  assert.deepEqual(e.quote, { asset: "USD", amount: 25 });
  assert.ok(e.unconvertedFeeSol > 0);
});

test("transfers keep the movement but price nothing", () => {
  const received = tx({ sig: "r", time: T, wallet: W, signer: false, sol: -0.002, tokens: { [M]: { ui: 5 } } });
  const sentNonSwap = tx({ sig: "n", time: T + 1, wallet: W, sol: 0.5, programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM], tokens: { [M]: { ui: -5 } } });
  const noQuote = tx({ sig: "q", time: T + 2, wallet: W, tokens: { [M]: { ui: 3 } } });
  const [a, b, c] = buildLedger(W, [received, sentNonSwap, noQuote]).entries as TransferEntry[];
  assert.deepEqual([a.kind, a.direction, a.reason], ["transfer", "in", "not_signer"]);
  assert.deepEqual([b.kind, b.direction, b.reason], ["transfer", "out", "no_swap_program"]);
  assert.deepEqual([c.kind, c.direction, c.reason], ["transfer", "in", "no_quote_leg"]);
});

test("SOL below the noise threshold (rent) is not a quote leg", () => {
  const e = buildLedger(W, [tx({ sig: "d", time: T, wallet: W, sol: -0.00204, tokens: { [M]: { ui: 5 } } })]).entries[0] as TransferEntry;
  assert.equal(e.kind, "transfer");
  assert.equal(e.reason, "no_quote_leg");
});

test("undecodable cases are kept as such: routes, token-to-token, SOL+USDC, wrong direction", () => {
  const route = tx({ sig: "1", time: T, wallet: W, sol: -0.5, tokens: { [addr(41)]: { ui: 1 }, [addr(42)]: { ui: 2 } } });
  const t2t = tx({ sig: "2", time: T + 1, wallet: W, sol: -0.00001, tokens: { [addr(41)]: { ui: -1 }, [addr(42)]: { ui: 2 } } });
  const both = tx({ sig: "3", time: T + 2, wallet: W, sol: -1, tokens: { [M]: { ui: 1 }, [USDC_MINT]: { ui: -50 } } });
  const wrong = tx({ sig: "4", time: T + 3, wallet: W, sol: 1, tokens: { [M]: { ui: 1 } } });
  const es = buildLedger(W, [route, t2t, both, wrong]).entries as UndecodableEntry[];
  assert.deepEqual(es.map((e) => [e.kind, e.reason]), [["undecodable", "multi_token"], ["undecodable", "token_to_token"], ["undecodable", "ambiguous_quote"], ["undecodable", "quote_wrong_direction"]]);
  assert.equal(es[0].legs.length, 2);
});

test("failed, unfinalized, duplicate and token-less transactions are not ledgered; failed fees are totalled", () => {
  const failed = tx({ sig: "f", time: T, wallet: W, sol: -0.000005, failed: true, tokens: { [M]: { ui: 1 } } });
  const noTime = { ...buy("n", T, W, M, 1, 1), time: null };
  const dup = buy("d", T + 5, W, M, 1, 1);
  const feeOnly = tx({ sig: "o", time: T + 6, wallet: W, sol: -0.000005 });
  const l = buildLedger(W, [failed, noTime, dup, dup, feeOnly]);
  assert.equal(l.entries.length, 1);
  assert.deepEqual(l.ignored.map((i) => i.reason).sort(), ["duplicate", "failed", "no_block_time", "no_token_change"]);
  assert.equal(l.failedTxCount, 1);
  assert.equal(l.failedFeeLamports, 5000);
});

test("tips are isolated only for configured tip accounts; never guessed", () => {
  const TIP = addr(77);
  const t = tx({ sig: "t", time: T, wallet: W, sol: -1.001, tokens: { [M]: { ui: 9 } }, extraLamports: { [TIP]: 1_000_000 } });
  const without = buildLedger(W, [t]).entries[0] as TradeEntry;
  assert.equal(without.tipLamports, 0);
  assert.ok(Math.abs(without.quote.amount - 1.000995) < 1e-9); // the tip is still inside the trade amount: not isolated
  const withTip = buildLedger(W, [t], { tipAccounts: [TIP] }).entries[0] as TradeEntry;
  assert.equal(withTip.tipLamports, 1_000_000);
  assert.ok(Math.abs(withTip.quote.amount - 0.999995) < 1e-9); // trading amount only
  assert.equal(withTip.allInSol, 1.001); // the all-in total is the same either way
});

test("the provider label is never trusted", () => {
  const t = { ...tx({ sig: "h", time: T, wallet: W, signer: false, tokens: { [M]: { ui: 1 } } }), providerHint: { type: "SWAP", source: "RAYDIUM" } };
  assert.equal(buildLedger(W, [t]).entries[0].kind, "transfer");
});

test("enhanced decoding (fee payer only in signers): a wallet whose lamports fell is treated as signer", () => {
  const t = { ...buy("e", T, W, M, 1, 1), signers: [addr(250)], signersComplete: false };
  assert.equal(buildLedger(W, [t]).entries[0].kind, "trade");
});

test("entries are chronological whatever the input order", () => {
  const l = buildLedger(W, [sell("s", T + 10, W, M, 1, 2), buy("b", T, W, M, 1, 1)]);
  assert.deepEqual(l.entries.map((e) => e.signature), ["b", "s"]);
});
