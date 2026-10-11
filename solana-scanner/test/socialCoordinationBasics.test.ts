import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, withConfig, validateConfig, builtinEntities, entityMap, extractSwap, extractTokenTransfer, normalizeTx, NormalizeError, JITO_TIP_ACCOUNTS } from "../src/social/coordination/index.ts";
import type { RawTx } from "../src/social/coordination/index.ts";
import { gini, hhi, poissonTail, cv, similar } from "../src/social/coordination/stats.ts";
import { MINT, PUMP_CURVE, PUMPSWAP, JUPITER, addr, sig, swapTx, solTransferTx, tokenTransferTx, N } from "./helpers/coordination.ts";

const SOL = 1_000_000_000n;

test("config: defaults follow the authorised limits (2 hops, 50 wallets) and are overridable", () => {
  assert.equal(DEFAULT_CONFIG.funding.maxHops, 2);
  assert.equal(DEFAULT_CONFIG.funding.maxWallets, 50);
  const c = withConfig({ funding: { maxHops: 3, maxWallets: 10 }, alpha: 0.05 });
  assert.equal(c.funding.maxHops, 3);
  assert.equal(c.funding.maxWallets, 10);
  assert.equal(c.alpha, 0.05);
  assert.equal(c.funding.burstSeconds, DEFAULT_CONFIG.funding.burstSeconds, "untouched fields keep their default");
  assert.equal(DEFAULT_CONFIG.funding.maxHops, 2, "withConfig never mutates the defaults");
});

test("config: invalid values are rejected", () => {
  assert.throws(() => withConfig({ funding: { maxHops: 0 } }), RangeError);
  assert.throws(() => withConfig({ funding: { maxWallets: 1.5 } }), RangeError);
  assert.throws(() => withConfig({ alpha: 2 }), RangeError);
  assert.throws(() => withConfig({ cluster: { minFamiliesForMulti: 3, minFamiliesForHypothesis: 2 } }), RangeError);
  assert.doesNotThrow(() => validateConfig(DEFAULT_CONFIG));
});

test("normalize: a buy yields side, base amount and a quote net of fee, rent and tip", () => {
  const trader = addr(1);
  const tip = JITO_TIP_ACCOUNTS[0]!;
  const tx = N(swapTx({ n: 1, slot: 100, trader, side: "buy", base: 5_000_000n, quote: SOL, rent: 2_039_280n, tip: { to: tip, lamports: 100_000n } }));
  const r = extractSwap(tx, MINT);
  assert.ok(r.swap);
  assert.equal(r.swap.side, "buy");
  assert.equal(r.swap.trader, trader);
  assert.equal(r.swap.baseAmount, 5_000_000n);
  assert.equal(r.swap.quoteAmount, SOL, "fee, ATA rent and Jito tip are not counted as the amount spent");
});

test("normalize: a sell yields the SOL received", () => {
  const tx = N(swapTx({ n: 2, slot: 101, trader: addr(2), side: "sell", base: 3_000_000n, quote: SOL / 2n }));
  const r = extractSwap(tx, MINT);
  assert.equal(r.swap?.side, "sell");
  assert.equal(r.swap?.quoteAmount, SOL / 2n);
});

test("normalize: failed transactions and other mints produce no swap", () => {
  assert.equal(extractSwap(N(swapTx({ n: 3, slot: 1, trader: addr(3), side: "buy", base: 1n, quote: SOL, failed: true })), MINT).skipped, "failed");
  assert.equal(extractSwap(N(swapTx({ n: 4, slot: 1, trader: addr(3), side: "buy", base: 1n, quote: SOL, mint: addr("other") })), MINT).skipped, "no_base_delta");
});

test("normalize: a token move without any DEX program is not a swap", () => {
  const raw = swapTx({ n: 5, slot: 1, trader: addr(4), side: "buy", base: 10n, quote: SOL, program: addr("unknown-program") });
  assert.equal(extractSwap(N(raw), MINT).skipped, "no_dex_program");
});

test("normalize: pool vault owners are never the trader (non-signers)", () => {
  const r = extractSwap(N(swapTx({ n: 6, slot: 1, trader: addr(5), side: "buy", base: 10n, quote: SOL, program: PUMPSWAP })), MINT);
  assert.equal(r.swap?.trader, addr(5));
});

test("normalize: swaps through an aggregator are attributed to the signer", () => {
  const r = extractSwap(N(swapTx({ n: 7, slot: 1, trader: addr(6), side: "sell", base: 10n, quote: SOL, program: JUPITER })), MINT);
  assert.equal(r.swap?.trader, addr(6));
  assert.ok(r.swap?.dexPrograms.includes(JUPITER));
});

test("normalize: SOL transfers are read from top-level system instructions", () => {
  const t = N(solTransferTx({ n: 8, slot: 9, from: addr(7), to: addr(8), lamports: 3n * SOL }));
  assert.equal(t.solTransfers.length, 1);
  assert.deepEqual([t.solTransfers[0]!.from, t.solTransfers[0]!.to, t.solTransfers[0]!.lamports], [addr(7), addr(8), 3n * SOL]);
});

test("token transfer pairing is exact or absent", () => {
  const ok = extractTokenTransfer(N(tokenTransferTx({ n: 9, slot: 5, from: addr(9), to: addr(10), amount: 777n })), MINT);
  assert.deepEqual([ok?.from, ok?.to, ok?.amount], [addr(9), addr(10), 777n]);
  // a transfer tax: sender loses more than the receiver gets → not paired
  const raw = tokenTransferTx({ n: 10, slot: 5, from: addr(9), to: addr(10), amount: 1000n });
  raw.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "990";
  assert.equal(extractTokenTransfer(N(raw), MINT), null);
  // a swap is never a wallet-to-wallet transfer
  assert.equal(extractTokenTransfer(N(swapTx({ n: 11, slot: 1, trader: addr(1), side: "buy", base: 5n, quote: SOL })), MINT), null);
});

test("normalize: malformed input throws NormalizeError instead of guessing", () => {
  const good = solTransferTx({ n: 12, slot: 1, from: addr(1), to: addr(2), lamports: SOL });
  assert.throws(() => normalizeTx({ ...good, meta: null }), NormalizeError);
  const badBal = structuredClone(good);
  badBal.meta!.preBalances = [1];
  assert.throws(() => normalizeTx(badBal), NormalizeError);
  const noSig = structuredClone(good);
  noSig.transaction.signatures = [];
  assert.throws(() => normalizeTx(noSig), NormalizeError);
  const noSigner = structuredClone(good) as RawTx;
  noSigner.transaction.message.accountKeys = [{ pubkey: addr(1), signer: false }, { pubkey: addr(2), signer: false }];
  assert.throws(() => normalizeTx(noSigner), NormalizeError);
  assert.throws(() => normalizeTx(null as unknown as RawTx), NormalizeError);
});

test("entities: built-ins hold programs and tip accounts, caller labels override", () => {
  const b = builtinEntities();
  assert.ok(b.has(PUMP_CURVE) && b.has(PUMPSWAP) && b.has(JUPITER));
  assert.equal(b.get(JUPITER)?.kind, "router");
  for (const t of JITO_TIP_ACCOUNTS) assert.ok(b.has(t));
  const m = entityMap({ [addr("cex")]: { kind: "exchange", label: "exchange X" } });
  assert.equal(m.get(addr("cex"))?.label, "exchange X");
  assert.equal(builtinEntities().has(addr("cex")), false, "extra labels never leak into the built-ins");
});

test("stats: poisson tail, hhi, gini, cv, similar", () => {
  assert.equal(poissonTail(0, 3), 1);
  assert.ok(Math.abs(poissonTail(1, 1) - (1 - Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(poissonTail(3, 2) - (1 - Math.exp(-2) * (1 + 2 + 2))) < 1e-12);
  assert.equal(poissonTail(5, 0), 0);
  assert.equal(hhi([1, 1, 1, 1]), 0.25);
  assert.equal(hhi([]), null);
  assert.equal(gini([1, 1, 1, 1]), 0);
  assert.ok(Math.abs(gini([0, 0, 0, 10])! - 0.75) < 1e-12);
  assert.equal(gini([5]), null);
  assert.equal(cv([2, 2, 2]), 0);
  assert.equal(cv([1]), null);
  assert.equal(similar(100n, 104n, 0.05), true);
  assert.equal(similar(100n, 120n, 0.05), false);
  assert.equal(similar(0n, 0n, 0.05), false);
});

test("sig and addr helpers produce valid ledger identifiers", async () => {
  const { isSignature, isSolanaAddress } = await import("../src/social/validate.ts");
  assert.ok(isSolanaAddress(addr(1)) && isSolanaAddress(MINT));
  assert.ok(isSignature(sig(1)));
});

test("entities: every venue program the on-chain module recognises is a DEX program here", async () => {
  const { KNOWN_PROGRAMS } = await import("../src/onchain/config.ts");
  const { DEX_PROGRAMS } = await import("../src/social/coordination/index.ts");
  for (const id of Object.keys(KNOWN_PROGRAMS)) assert.ok(DEX_PROGRAMS[id], `${id} (${KNOWN_PROGRAMS[id]!.name})`);
});

test("an unclassified token movement is counted in the limits, not dropped silently", async () => {
  const { analyzeCoordination } = await import("../src/social/coordination/index.ts");
  const { cov } = await import("./helpers/coordination.ts");
  const raw = swapTx({ n: 21, slot: 5, trader: addr(1), side: "buy", base: 10n, quote: SOL, program: addr("not-a-dex") });
  raw.meta!.postTokenBalances![0]!.uiTokenAmount.amount = "9"; // receives less than the other side lost: no exact pairing
  const odd = N(raw);
  const r = analyzeCoordination({ mint: MINT, creator: null, supplyRaw: null, txs: [odd], coverage: cov(), provider: () => null });
  assert.equal(r.skipped.no_dex_program, 1);
  assert.ok(r.limits.some((l) => l.includes("sans programme DEX connu")));
});

// ---------------------------------------------------------------- quote legs other than SOL

import { tokenQuoteSwapTx } from "./helpers/coordination.ts";
import { USDC_MINT, WSOL_MINT, isRoundAmount, QUOTE_DECIMALS } from "../src/social/coordination/index.ts";

test("quote leg: a USDC-quoted swap is read as USDC, not as SOL", () => {
  const buy = extractSwap(N(tokenQuoteSwapTx({ n: 30, slot: 1, trader: addr(1), side: "buy", base: 500n, quote: 25_000_000n, quoteMint: USDC_MINT, solDust: 3_000n })), MINT).swap!;
  assert.equal(buy.quoteMint, USDC_MINT);
  assert.equal(buy.quoteAmount, 25_000_000n);
  assert.equal(buy.side, "buy");
  const sell = extractSwap(N(tokenQuoteSwapTx({ n: 31, slot: 1, trader: addr(1), side: "sell", base: 500n, quote: 24_000_000n, quoteMint: USDC_MINT })), MINT).swap!;
  assert.deepEqual([sell.side, sell.quoteMint, sell.quoteAmount], ["sell", USDC_MINT, 24_000_000n]);
});

test("quote leg: an unlisted quote token (a memecoin pair) is inferred and amounts stay raw", () => {
  const other = addr("quote-memecoin");
  const s = extractSwap(N(tokenQuoteSwapTx({ n: 32, slot: 1, trader: addr(1), side: "buy", base: 10n, quote: 987_654n, quoteMint: other })), MINT).swap!;
  assert.equal(s.quoteMint, other);
  assert.equal(QUOTE_DECIMALS[other], undefined);
});

test("quote leg: declared quote mints decide when several legs move the right way", () => {
  const tx = N(tokenQuoteSwapTx({ n: 33, slot: 1, trader: addr(1), side: "buy", base: 10n, quote: 1_000_000n, quoteMint: USDC_MINT, extraQuote: { mint: addr("junk"), delta: -123n } }));
  assert.equal(extractSwap(tx, MINT, { quoteMints: [USDC_MINT] }).swap!.quoteMint, USDC_MINT);
  assert.equal(extractSwap(tx, MINT, { quoteMints: [addr("junk")] }).swap!.quoteAmount, 123n);
  // no declaration: the largest right-way leg wins deterministically
  assert.equal(extractSwap(tx, MINT).swap!.quoteMint, USDC_MINT);
});

test("quote leg: a priced swap with no usable quote leg keeps amount 0 instead of inventing one", () => {
  const s = extractSwap(N(tokenQuoteSwapTx({ n: 34, slot: 1, trader: addr(1), side: "buy", base: 10n, quote: 0n, quoteMint: USDC_MINT })), MINT).swap!;
  assert.equal(s.quoteAmount, 0n);
});

test("quote leg: a result uses one quote mint; swaps priced in another are set aside and reported", async () => {
  const { analyzeCoordination } = await import("../src/social/coordination/index.ts");
  const { cov } = await import("./helpers/coordination.ts");
  const txs = [
    ...[1, 2, 3].map((i) => N(tokenQuoteSwapTx({ n: 40 + i, slot: 100 + i, trader: addr(i), side: "buy", base: 100n, quote: 50_000_000n + BigInt(i), quoteMint: USDC_MINT }))),
    N(swapTx({ n: 50, slot: 120, trader: addr(9), side: "buy", base: 10n, quote: SOL, program: PUMP_CURVE })),
  ];
  const r = analyzeCoordination({ mint: MINT, creator: null, supplyRaw: null, txs, coverage: cov(), provider: () => null });
  assert.equal(r.quoteMint, USDC_MINT);
  assert.equal(r.quoteDecimals, 6);
  assert.equal(r.swaps.length, 3);
  assert.equal(r.skipped.other_quote_mint, 1);
  assert.ok(r.limits.some((l) => l.includes("autre token")));
});

test("dust filter is per quote mint: 0.005 USDC is dust, 0.005 SOL is not", async () => {
  const { analyzeLaunch, entityMap } = await import("../src/social/coordination/index.ts");
  const { cov, swapEvent, BASE_SLOT } = await import("./helpers/coordination.ts");
  const usd = { ...swapEvent(1, BASE_SLOT, addr(1), "buy", 10n, 5_000n), quoteMint: USDC_MINT };
  const sol = swapEvent(2, BASE_SLOT, addr(2), "buy", 10n, 5_000_000n);
  const r = analyzeLaunch({ mint: MINT, swaps: [usd, sol], creator: null, entities: entityMap(), supplyRaw: null, coverage: cov() });
  assert.deepEqual(r.cohort.map((m) => m.wallet), [addr(2)]);
  assert.equal(WSOL_MINT.length > 0, true);
});

test("round amounts: default picks are recognised at any magnitude, odd amounts are not", () => {
  for (const v of [1_000_000_000n, 500_000_000n, 1_500_000_000n, 100_000_000n, 25_000_000n, 250_000n, 50n]) assert.equal(isRoundAmount(v), true, String(v));
  for (const v of [777_000_000n, 1_230_000_000n, 41_700_000n, 313_370n, 0n]) assert.equal(isRoundAmount(v), false, String(v));
});

// ---------------------------------------------------------------- Helius adapter (documented-shape fixtures)

test("helius adapter: funding transfers, token changes and programs are read; swaps are attributed to the fee payer", async () => {
  const { normalizeHeliusTx, extractSwap: ex } = await import("../src/social/coordination/index.ts");
  const trader = addr(1);
  const tx = normalizeHeliusTx({
    signature: sig(900), slot: 100, timestamp: 1_791_000_000, feePayer: trader, fee: 5000,
    nativeTransfers: [{ fromUserAccount: addr(2), toUserAccount: trader, amount: 2_000_000_000 }],
    accountData: [
      { account: trader, nativeBalanceChange: -1_000_005_000, tokenBalanceChanges: [{ userAccount: trader, mint: MINT, rawTokenAmount: { tokenAmount: "777" } }] },
      { account: addr(3), nativeBalanceChange: 1_000_000_000, tokenBalanceChanges: [{ userAccount: addr(3), mint: MINT, rawTokenAmount: { tokenAmount: "-777" } }] },
    ],
    instructions: [{ programId: PUMP_CURVE, innerInstructions: [{ programId: "11111111111111111111111111111111" }] }],
  });
  assert.equal(tx.solTransfers[0]!.lamports, 2_000_000_000n);
  assert.deepEqual(tx.programs, ["11111111111111111111111111111111", PUMP_CURVE].sort());
  const s = ex(tx, MINT).swap!;
  assert.deepEqual([s.trader, s.side, s.baseAmount, s.quoteAmount], [trader, "buy", 777n, 1_000_000_000n]);
  assert.throws(() => normalizeHeliusTx({ signature: "x" } as never), NormalizeError);
  assert.equal(normalizeHeliusTx({ signature: sig(901), slot: 1, feePayer: trader, fee: 1, transactionError: { err: 1 } }).failed, true);
});
