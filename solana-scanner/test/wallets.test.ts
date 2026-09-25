import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import type { ParsedTransaction } from "../src/onchain/rpc.ts";
import { collectWalletFacts, HistoryBudget, tradesInTx } from "../src/wallets/collect.ts";
import type { WalletRpc } from "../src/wallets/collect.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { aggregateBuyers, buildIntel, shortlist } from "../src/wallets/intel.ts";
import { buildPositions, computeMetrics, profileWallet } from "../src/wallets/profile.ts";
import type { ProfileContext } from "../src/wallets/profile.ts";
import { decodeTrade, WSOL_MINT } from "../src/wallets/trades.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const MINT = key(1);
const OTHER = key(2);
const POOL = key(3);
const W = key(10);
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;

/** A swap: `owner` (signer) gives/gets SOL, the pool (non-signer) the opposite. */
function swapTx(opts: { owner: string; mint: string; tokenDelta: bigint; lamportDelta: number; wsolDelta?: bigint; time?: number; slot?: number; sig?: string; extraMint?: string }): ParsedTransaction {
  const bal = (owner: string, mint: string, amount: bigint, i: number) => ({ accountIndex: i, mint, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null } });
  const pre = [bal(opts.owner, opts.mint, 1_000_000_000n, 1), bal(POOL, opts.mint, 900_000_000_000n, 2)];
  const post = [bal(opts.owner, opts.mint, 1_000_000_000n + opts.tokenDelta, 1), bal(POOL, opts.mint, 900_000_000_000n - opts.tokenDelta, 2)];
  if (opts.wsolDelta) {
    pre.push({ accountIndex: 3, mint: WSOL_MINT, owner: opts.owner, uiTokenAmount: { amount: "5000000000", decimals: 9, uiAmount: null } });
    post.push({ accountIndex: 3, mint: WSOL_MINT, owner: opts.owner, uiTokenAmount: { amount: (5_000_000_000n + opts.wsolDelta).toString(), decimals: 9, uiAmount: null } });
  }
  if (opts.extraMint) {
    pre.push(bal(opts.owner, opts.extraMint, 0n, 4));
    post.push(bal(opts.owner, opts.extraMint, 5n, 4));
  }
  return {
    slot: opts.slot ?? 100,
    blockTime: Math.floor((opts.time ?? T0) / 1000),
    transaction: {
      signatures: [opts.sig ?? "sig"],
      message: { accountKeys: [{ pubkey: opts.owner, signer: true, writable: true }, { pubkey: POOL, signer: false, writable: true }], instructions: [] },
    },
    meta: { err: null, fee: 5000, preBalances: [10e9, 1e9], postBalances: [10e9 + opts.lamportDelta, 1e9 - opts.lamportDelta], preTokenBalances: pre, postTokenBalances: post },
  };
}

const trade = (mint: string, side: "buy" | "sell", sol: number, tokens: number, t: number): Trade => ({ signature: `${mint}${side}${t}`, slot: null, time: t, owner: W, mint, side, tokenAmount: tokens, sol });

const facts = (o: Partial<WalletFacts> = {}): WalletFacts => ({
  address: W,
  signatureCount: 40,
  historyComplete: true,
  firstSeen: min(-30 * 24 * 60),
  funder: key(50),
  fundingSignature: "f",
  fundingTime: min(-30 * 24 * 60),
  funderSignatureCount: null,
  signatures: [],
  trades: [],
  historyNote: "historique complet",
  undecodableTxs: 0,
  ...o,
});
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: key(90), creatorFunder: key(91), launchTime: min(0), relatedTo: [], launchTimes: {}, pricesSol: {}, now: min(600), ...o });

// ─── trade decoding ──────────────────────────────────────────────────────

test("decodes a buy paid in native SOL and a sell paid in wrapped SOL", () => {
  const buy = decodeTrade(swapTx({ owner: W, mint: MINT, tokenDelta: 2_000_000n, lamportDelta: -0.5e9 }), W, MINT);
  assert.ok(buy.ok);
  if (buy.ok) {
    assert.equal(buy.trade.side, "buy");
    assert.equal(buy.trade.tokenAmount, 2);
    assert.equal(buy.trade.sol, 0.5);
  }
  const sell = decodeTrade(swapTx({ owner: W, mint: MINT, tokenDelta: -1_000_000n, lamportDelta: -5000, wsolDelta: 800_000_000n }), W, MINT);
  assert.ok(sell.ok);
  if (sell.ok) {
    assert.equal(sell.trade.side, "sell");
    assert.ok(Math.abs(sell.trade.sol - 0.799995) < 1e-9);
  }
});

test("a token transfer (no SOL leg) and a multi-token route are not guessed", () => {
  assert.deepEqual(decodeTrade(swapTx({ owner: W, mint: MINT, tokenDelta: -1_000_000n, lamportDelta: -5000 }), W, MINT), { ok: false, reason: "transfer" });
  assert.deepEqual(decodeTrade(swapTx({ owner: W, mint: MINT, tokenDelta: 1_000_000n, lamportDelta: -1e9, extraMint: OTHER }), W, MINT), { ok: false, reason: "multi_token" });
});

test("only signers count as traders: the pool's balance change is not a trade", () => {
  const { trades } = tradesInTx(swapTx({ owner: W, mint: MINT, tokenDelta: 3_000_000n, lamportDelta: -1e9 }), MINT);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].owner, W);
});

// ─── positions & metrics ─────────────────────────────────────────────────

test("positions: realised return on closed trades, estimated value on open ones, unknown price stays unknown", () => {
  const trades = [
    trade(MINT, "buy", 1, 100, min(2)),
    trade(MINT, "sell", 3, 100, min(62)),
    trade(OTHER, "buy", 2, 50, min(10)),
  ];
  const pos = buildPositions(trades, { [MINT]: min(0) }, {});
  const a = pos.find((p) => p.mint === MINT)!;
  const b = pos.find((p) => p.mint === OTHER)!;
  assert.equal(a.realizedReturn, 2);
  assert.equal(a.totalReturnEst, 2);
  assert.equal(a.entryMinutesAfterLaunch, 2);
  assert.equal(a.holdMinutes, 60);
  assert.equal(b.heldValueSolEst, null, "no price → no invented value");
  assert.equal(b.totalReturnEst, null);
  assert.equal(b.entryMinutesAfterLaunch, null, "launch unknown");

  const withPrice = buildPositions(trades, {}, { [OTHER]: 0.06 });
  assert.ok(Math.abs(withPrice.find((p) => p.mint === OTHER)!.totalReturnEst! - 0.5) < 1e-9);
  const m = computeMetrics(buildPositions(trades, { [MINT]: min(0) }, {}));
  assert.equal(m.evaluated, 1);
  assert.equal(m.early.known, 1);
  assert.equal(m.early.lt5m, 1);
});

// ─── false "smart wallets" ───────────────────────────────────────────────

test("one or two lucky trades never make a high-quality wallet", () => {
  const p = profileWallet(facts({ trades: [trade(MINT, "buy", 1, 100, min(1)), trade(MINT, "sell", 20, 100, min(30))] }), ctx(), min(1));
  assert.equal(p.metrics!.evaluated, 1);
  assert.equal(p.metrics!.best!.totalReturnEst, 19);
  assert.ok(p.quality < WALLET_CONFIG.highQualityThreshold, `quality ${p.quality}`);
  assert.equal(p.confidence, "LOW");
});

test("a long consistent complete history can reach HIGH confidence", () => {
  const trades: Trade[] = [];
  for (let i = 0; i < 30; i++) {
    const m = key(100 + i);
    const t = min(i * 120);
    trades.push({ ...trade(m, "buy", 1, 100, t) }, { ...trade(m, "sell", i % 3 === 0 ? 0.8 : 1.6, 100, t + 30 * 60_000) });
  }
  const p = profileWallet(facts({ signatureCount: 70, trades }), ctx(), min(0));
  assert.equal(p.metrics!.evaluated, 30);
  assert.equal(p.confidence, "HIGH");
  assert.ok(p.quality >= WALLET_CONFIG.highQualityThreshold, `quality ${p.quality}`);
});

test("history too long for the free RPC: metrics UNKNOWN, LOW confidence, bot-like flag", () => {
  const p = profileWallet(facts({ signatureCount: 5000, historyComplete: false, trades: null, historyNote: "≥ 5,000 transactions" }), ctx(), min(1));
  assert.equal(p.metrics, null);
  assert.equal(p.confidence, "LOW");
  assert.ok(p.flags.some((f) => f.key === "busy"));
  assert.ok(p.flags.some((f) => f.key === "incomplete"));
  assert.ok(p.unknowns.some((u) => u.includes("UNKNOWN")));
  assert.equal(p.quality, 0);
});

test("suspicious patterns are penalised: fresh wallet, funded just before launch, linked to the deployer", () => {
  const fresh = profileWallet(facts({ firstSeen: min(-30), fundingTime: min(-20), funder: key(91) }), ctx(), min(1));
  const keys = fresh.flags.map((f) => f.key);
  assert.ok(keys.includes("fresh"));
  assert.ok(keys.includes("fundedBeforeLaunch"));
  assert.ok(keys.includes("sameFunderAsCreator"));
  const byCreator = profileWallet(facts({ funder: key(90) }), ctx(), min(1));
  assert.ok(byCreator.flags.some((f) => f.key === "fundedByCreator"));
});

test("micro-transactions and buying almost every new token are flagged", () => {
  const trades = Array.from({ length: 30 }, (_, i) => trade(key(120 + i), "buy", 0.002, 10, min(i)));
  const p = profileWallet(facts({ signatureCount: 40, trades }), ctx(), min(0));
  assert.ok(p.flags.some((f) => f.key === "micro"));
  assert.ok(p.flags.some((f) => f.key === "buysEverything"));
});

// ─── token-level intel & cluster adjustment ──────────────────────────────

function scanWith(trades: Trade[]): TokenScan {
  return { mint: MINT, launch: { time: min(0), slot: 100, signature: "launch" }, signaturesScanned: 500, launchReachable: true, transactionsFetched: trades.length, transactionsFailed: 0, undecodable: 0, earlyTrades: trades, recentTrades: [], supply: 1_000_000_000, solUsd: 150 };
}

test("3 wallets funded in the same transaction count as 1 independent cluster", () => {
  const A = key(60), B = key(61), C = key(62), D = key(63), CREATOR = key(90);
  const t = (owner: string, m: number, sol = 1, slot = 101): Trade => ({ signature: `s${owner}`, slot, time: min(m), owner, mint: MINT, side: "buy", tokenAmount: 10_000_000, sol });
  const scan = scanWith([t(CREATOR, 0, 50, 100), t(A, 0.1, 1, 100), t(B, 0.2), t(C, 0.3), t(D, 5)]);
  const buyers = aggregateBuyers(scan, { creator: CREATOR, holdersPct: null, excluded: () => false });
  assert.equal(buyers.length, 4, "deployment wallet excluded");
  const f = (address: string, funding: string, funder = key(70)) => facts({ address, funder, fundingSignature: funding, signatures: [funding] });
  const intel = buildIntel(scan, buyers, [f(A, "same"), f(B, "same"), f(C, "same"), f(D, "own", key(71))], {
    creator: CREATOR, creatorFunder: null, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: min(10),
  });
  assert.equal(intel.tracked.length, 4);
  assert.equal(intel.independentClusters, 2);
  const cl = new Set(intel.tracked.filter((x) => [A, B, C].includes(x.address)).map((x) => x.cluster));
  assert.equal(cl.size, 1);
  assert.ok(intel.tracked.find((x) => x.address === A)!.profile.flags.some((fl) => fl.key === "related"));
  assert.equal(intel.creatorBuys!.tokenPct, 1);
  assert.equal(intel.creatorBuys!.inLaunchSlot, true);
  assert.equal(intel.launchSlotBuyers, 1);
  assert.ok(Math.abs(buyers.find((b) => b.address === A)!.entryMcapUsdEst! - 15_000) < 1e-6); // 1 SOL / 10 tokens × 1e9 supply × $150
});

test("shortlist mixes earliest and largest buyers; dust buys are ignored", () => {
  const t = (owner: string, m: number, sol: number): Trade => ({ signature: `s${owner}`, slot: 101, time: min(m), owner, mint: MINT, side: "buy", tokenAmount: 1000, sol });
  const scan = scanWith([t(key(80), 1, 0.2), t(key(81), 2, 0.2), t(key(82), 50, 30), t(key(83), 3, 0.001)]);
  const buyers = aggregateBuyers(scan, { creator: null, holdersPct: null, excluded: () => false });
  assert.ok(!buyers.some((b) => b.address === key(83)), "dust ignored");
  const sl = shortlist(buyers, 2).map((b) => b.address);
  assert.deepEqual(sl, [key(80), key(82)]);
});

// ─── collection with a fake RPC ──────────────────────────────────────────

test("wallet facts: complete small history reconstructed; long history left UNKNOWN; RPC failure propagates", async () => {
  const sigs = [{ signature: "b", blockTime: min(10) / 1000, err: null }, { signature: "a", blockTime: min(0) / 1000, err: null }];
  const txs: Record<string, ParsedTransaction> = {
    a: swapTx({ owner: W, mint: MINT, tokenDelta: 1_000_000n, lamportDelta: -1e9, time: min(0), sig: "a" }),
    b: swapTx({ owner: W, mint: MINT, tokenDelta: -1_000_000n, lamportDelta: 2e9, time: min(10), sig: "b" }),
  };
  const rpc: WalletRpc = { url: "fake", getSignatures: async () => sigs, getTransaction: async (s: string) => txs[s] } as WalletRpc;
  const f = await collectWalletFacts(rpc, W, new HistoryBudget(10));
  assert.equal(f.historyComplete, true);
  assert.equal(f.trades!.length, 2);

  const busy: WalletRpc = { url: "fake", getSignatures: async () => Array.from({ length: 1000 }, (_, i) => ({ signature: `x${i}`, blockTime: 1, err: null })), getTransaction: async () => null } as WalletRpc;
  const g = await collectWalletFacts(busy, W, new HistoryBudget(10));
  assert.equal(g.trades, null);
  assert.equal(g.historyComplete, false);
  assert.match(g.historyNote, /trop long/);

  const noBudget = await collectWalletFacts(rpc, W, new HistoryBudget(0));
  assert.equal(noBudget.trades, null);
  assert.match(noBudget.historyNote, /budget/);

  const down: WalletRpc = { url: "fake", getSignatures: async () => { throw new Error("RPC down"); }, getTransaction: async () => null } as WalletRpc;
  await assert.rejects(collectWalletFacts(down, W, new HistoryBudget(10)), /RPC down/);
});
