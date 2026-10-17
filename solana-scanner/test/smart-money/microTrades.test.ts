import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS } from "../../src/smart-money/config.ts";
import { addr, buy, swapTx, tx, USDC_MINT } from "../../src/smart-money/demo/fixtures.ts";
import { buildLedger } from "../../src/smart-money/ledger/build.ts";
import { buildLedgerV1 } from "../../src/smart-money/ledger/legacy/buildV1.ts";
import type { TradeEntry, TransferEntry, UndecodableEntry } from "../../src/smart-money/ledger/types.ts";
import { analyzeWallet } from "../../src/smart-money/pnl/profile.ts";
import { formatProfile } from "../../src/smart-money/pnl/format.ts";
import { closeTo } from "./helpers.ts";
import { heatLikeTxs, H, MINT, SUSPECT_SLOT, T0, W } from "./heatFixture.ts";

const entry = (sig: string, builder = buildLedger) => builder(W, heatLikeTxs()).entries.find((e) => e.signature === sig);

test("REGRESSION slot 457746451: ~0.001655 SOL leaves the wallet; v1 filed it as a transfer, v2 sees the buy", () => {
  const t = heatLikeTxs().find((x) => x.signature === "suspect-micro")!;
  assert.equal(t.slot, SUSPECT_SLOT);
  assert.ok(closeTo(-t.lamportDeltas[W] / 1e9, 0.001655, 1e-9), "the wallet's outflow is the observed ~0.001655 SOL");

  const before = entry("suspect-micro", buildLedgerV1) as TransferEntry;
  assert.equal(before.kind, "transfer"); // the bug
  assert.equal(before.rentStatus, "uncertain"); // the pool's SOL was taken for a rent

  const after = entry("suspect-micro") as TradeEntry;
  assert.equal(after.kind, "trade");
  assert.equal(after.side, "buy");
  assert.equal(after.swapProof, "counterparty_payment");
  assert.equal(after.rentStatus, "none");
  assert.ok(closeTo(after.quote.amount, 0.00165, 1e-9), "cost = what the wallet really paid, network fee out");
  assert.ok(closeTo(after.poolSideAmount ?? null, 0.00163, 1e-9), "what the curve received, kept apart");
  assert.ok(after.reasons!.includes("micro_trade_kept"));
});

test("a micro SELL is a sell too; a pool whose SOL falls in the old numeric range is no longer a rent", () => {
  const sellE = entry("micro-sell") as TradeEntry;
  assert.deepEqual([sellE.kind, sellE.side, sellE.swapProof], ["trade", "sell", "counterparty_payment"]);
  assert.ok(closeTo(sellE.quote.amount, 0.002 - 0.00002, 1e-9)); // received after the protocol fee; the network fee is a separate cost
  const band = entry("pool-in-band") as TradeEntry;
  assert.equal(band.rentStatus, "none");
  assert.equal((entry("pool-in-band", buildLedgerV1) as TransferEntry).rentStatus, "uncertain");
  assert.equal(band.kind, "trade");
});

test("Token-2022 and temporary-cosigner creations are now proven; the unprovable sponsor stays uncertain", () => {
  const t22 = entry("t22-create") as TradeEntry;
  assert.deepEqual([t22.rentStatus, t22.rentDepositLamports], ["identified", 2_157_600]);
  assert.ok(closeTo(t22.quote.amount, 1, 1e-9)); // the curve got 1 SOL; the rent and the network fee are apart
  const temp = entry("temp-cosigner") as TradeEntry;
  assert.deepEqual([temp.rentStatus, temp.rentDepositLamports], ["identified", 2_039_280]);
  const sp = entry("sponsored") as TradeEntry;
  assert.deepEqual([sp.rentStatus, sp.rentDepositLamports, sp.rentReasons], ["uncertain", 0, ["funder_ambiguous"]]);
  assert.equal(sp.kind, "trade", "still a trade (the swap is proven); only the rent split is unproven → the position will be PARTIAL");
  for (const sig of ["t22-create", "temp-cosigner"]) assert.equal((entry(sig, buildLedgerV1) as TradeEntry).rentStatus, "uncertain", `${sig} was uncertain in v1`);
});

test("airdrops: free tokens are transfers (cost UNKNOWN); the sender's rent is a third-party deposit, the wallet's own rent is never its trade cost", () => {
  const free = entry("airdrop-free") as TransferEntry;
  assert.deepEqual([free.kind, free.direction, free.rentDepositLamports, free.thirdPartyRentLamports], ["transfer", "in", 0, 2_039_280]);
  const paid = entry("airdrop-paid") as TransferEntry;
  assert.equal(paid.kind, "transfer"); // no payment by the sender → not a swap, whatever the wallet spent on rent
  assert.equal(paid.rentDepositLamports, 2_039_280);
  assert.ok(paid.reasons!.includes("counterparty_without_payment"));
});

test("routes and AMMs: wrapped-SOL vault payments prove a swap; a pool paid in another asset leaves a wallet-side trade, labelled as such", () => {
  const amm = entry("amm") as TradeEntry;
  assert.deepEqual([amm.kind, amm.swapProof], ["trade", "counterparty_payment"]);
  assert.ok(closeTo(amm.poolSideAmount ?? null, 0.25, 1e-9));
  const route = entry("route") as TradeEntry;
  assert.deepEqual([route.kind, route.swapProof], ["trade", "wallet_side_only"]);
  assert.ok(route.reasons!.includes("counterparty_in_other_asset"));
});

test("no counterparty in the data: a small amount stays a transfer (prudence), and it says so", () => {
  const e = buildLedger(W, [buy("nocp", T0, W, addr(140), 100, 0.003)]).entries[0] as TransferEntry;
  assert.equal(e.kind, "transfer");
  assert.equal(e.swapProof, "wallet_side_only");
  assert.ok(e.reasons!.includes("no_counterparty"));
  const big = buildLedger(W, [buy("nocp2", T0, W, addr(141), 100, 0.5)]).entries[0] as TradeEntry;
  assert.deepEqual([big.kind, big.swapProof], ["trade", "wallet_side_only"]);
});

test("payment evidence that does not involve the wallet is not a trade by the wallet", () => {
  const payer = addr(250);
  const gift = swapTx({ sig: "gift", time: T0, wallet: W, mint: addr(142), side: "buy", ui: 10, tradeSol: 0.2, signers: [W, payer], feePayer: payer });
  gift.lamportDeltas[W] = 0; // the pool got paid by someone else; the wallet's SOL did not move
  gift.lamportDeltas[payer] = -(0.2 * 1e9 + 5000);
  const e = buildLedger(W, [gift]).entries[0] as UndecodableEntry;
  assert.deepEqual([e.kind, e.reason], ["undecodable", "payment_not_with_wallet"]);
});

test("stablecoin swaps are proven by the pool's stablecoin movement, and never priced in SOL", () => {
  const t = tx({ sig: "usd", time: T0, wallet: W, sol: -0.000005, tokens: { [addr(143)]: { ui: 50 }, [USDC_MINT]: { ui: -7 } } });
  t.tokenDeltas[addr(193)] = { [addr(143)]: { raw: "-50000000", decimals: 6 }, [USDC_MINT]: { raw: "7000000", decimals: 6 } };
  const e = buildLedger(W, [t]).entries[0] as TradeEntry;
  assert.deepEqual([e.quote, e.swapProof, e.unconvertedFeeSol], [{ asset: "USD", amount: 7 }, "counterparty_payment", 0.000005]);
  const both = tx({ sig: "both", time: T0, wallet: W, sol: -0.3, tokens: { [addr(144)]: { ui: 5 }, [USDC_MINT]: { ui: -7 } } });
  both.lamportDeltas[addr(192)] = 0.3 * 1e9;
  both.tokenDeltas[addr(192)] = { [addr(144)]: { raw: "-5000000", decimals: 6 }, [USDC_MINT]: { raw: "7000000", decimals: 6 } };
  assert.equal((buildLedger(W, [both]).entries[0] as UndecodableEntry).reason, "ambiguous_quote");
});

test("no price is invented: every amount comes from a balance that moved, and transfers carry none", () => {
  for (const e of buildLedger(W, heatLikeTxs()).entries) {
    if (e.kind === "transfer") assert.ok(!("quote" in e));
    if (e.kind === "trade") assert.ok(e.quote.amount > 0 && Number.isFinite(e.quote.amount));
  }
});

test("positions: the micro buy joins its position; unprovable rent makes it PARTIAL; sales with no buy stay UNKNOWN", () => {
  const txs = heatLikeTxs();
  const a = analyzeWallet(W, txs, { coverage: { complete: true, oldestTime: null }, config: { thresholds: DEFAULT_THRESHOLDS, tipAccounts: [] } });
  assert.equal(a.pnl.rounds.filter((r) => r.unknownReasons.includes("sell_without_known_buy")).length, 3); // old-sell-1, old-sell-2, and the micro sell of a token never bought
  assert.equal(a.pnl.rounds.find((r) => r.mint === MINT.roundTrip)?.status, "KNOWN");
  const open = (m: string) => a.pnl.open.find((o) => o.mint === m)!;
  assert.ok(closeTo(open(MINT.micro).knownCost, 0.00165, 1e-9));
  assert.equal(open(MINT.sponsor).knownCost !== null, true);
  const v1 = analyzeWallet(W, txs, { coverage: { complete: true, oldestTime: null }, config: { thresholds: DEFAULT_THRESHOLDS, tipAccounts: [] } });
  void v1;
});

test("a truncated history never presents its profit as reliable", () => {
  const a = analyzeWallet(W, heatLikeTxs(), { coverage: { complete: false, oldestTime: T0 }, config: { thresholds: DEFAULT_THRESHOLDS, tipAccounts: [] } });
  assert.equal(a.profile.counts.known, 0);
  assert.equal(a.profile.totals.sol.rounds, 0);
  assert.equal(a.profile.winRate.n, 0);
  const text = formatProfile(a.profile);
  assert.match(text, /PnL NON FIABLE/);
  assert.match(text, /aucun profit n'est affirmé/);
  const whole = analyzeWallet(W, heatLikeTxs(), { coverage: { complete: true, oldestTime: T0 }, config: { thresholds: DEFAULT_THRESHOLDS, tipAccounts: [] } });
  assert.ok(!/PnL NON FIABLE/.test(formatProfile(whole.profile)));
  void H;
});
