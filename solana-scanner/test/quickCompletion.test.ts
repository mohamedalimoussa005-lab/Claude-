import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import type { SignatureInfo } from "../src/onchain/rpc.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import type { HistoryConfig } from "../src/history/config.ts";
import { HeliusHistoryProvider } from "../src/history/helius.ts";
import type { EnhancedTransaction } from "../src/history/normalize.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { collectWalletFactsFromHistory, DeepBudget } from "../src/wallets/historyFacts.ts";
import { profileWallet } from "../src/wallets/profile.ts";
import type { ProfileContext } from "../src/wallets/profile.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const POOL = key(3);
const FUNDER = key(4);
const OTHER = key(5);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYSTEM = "11111111111111111111111111111111";
const T0 = 1_780_000_000;
const mint = (i: number) => base58Encode(new Uint8Array(32).map((_, j) => (j === 0 ? 100 + (i % 100) : j === 1 ? 1 + Math.floor(i / 100) : 7)));

type Kind = { t: "funding" } | { t: "buy"; m: number; tokens?: bigint } | { t: "sell"; m: number; sol: number; tokens?: bigint } | { t: "sol" } | { t: "failed" };

function enhanced(i: number, k: Kind): EnhancedTransaction {
  const base = { signature: `s${i}`, slot: i, timestamp: T0 + i * 60, fee: 5000, type: "SWAP", source: "PUMP_FUN", transactionError: null };
  const acct = (a: string, lamports: number, tokens: { mint: string; delta: bigint }[] = []) => ({ account: a, nativeBalanceChange: lamports, tokenBalanceChanges: tokens.map((t) => ({ userAccount: a, mint: t.mint, rawTokenAmount: { tokenAmount: t.delta.toString(), decimals: 6 } })) });
  switch (k.t) {
    case "funding":
      return { ...base, feePayer: FUNDER, type: "TRANSFER", source: "SYSTEM_PROGRAM", accountData: [acct(FUNDER, -2e9 - 5000), acct(W, 2e9)], instructions: [{ programId: SYSTEM }] };
    case "buy": {
      const tk = k.tokens ?? 1_000_000n;
      return { ...base, feePayer: W, accountData: [acct(W, -0.5e9, [{ mint: mint(k.m), delta: tk }]), acct(POOL, 0.5e9, [{ mint: mint(k.m), delta: -tk }])], instructions: [{ programId: PUMP }] };
    }
    case "sell": {
      const tk = k.tokens ?? 1_000_000n;
      return { ...base, feePayer: W, accountData: [acct(W, k.sol * 1e9, [{ mint: mint(k.m), delta: -tk }]), acct(POOL, -k.sol * 1e9, [{ mint: mint(k.m), delta: tk }])], instructions: [{ programId: PUMP }] };
    }
    default:
      return { ...base, feePayer: W, type: "TRANSFER", source: "SYSTEM_PROGRAM", accountData: [acct(W, -1e6 - 5000), acct(OTHER, 1e6)], instructions: [{ programId: SYSTEM }] };
  }
}

/** A wallet history of `n` signatures (1 = oldest); `kind(i)` decides each transaction. Served by an offline Helius fallback. */
function wallet(n: number, kind: (i: number) => Kind, walkPages = 10) {
  const sigs: SignatureInfo[] = Array.from({ length: n }, (_, k) => {
    const i = n - k;
    return { signature: `s${i}`, slot: i, blockTime: T0 + i * 60, err: kind(i).t === "failed" ? { InstructionError: [0, "x"] } : null };
  });
  const calls = { gtfa: 0, signatures: 0, enhanced: 0, enhancedTxs: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).includes("/v0/transactions")) {
      calls.enhanced++;
      calls.enhancedTxs += body.transactions.length;
      return new Response(JSON.stringify(body.transactions.map((s: string) => enhanced(Number(s.slice(1)), kind(Number(s.slice(1)))))), { status: 200 });
    }
    if (body.method === "getTransactionsForAddress") {
      calls.gtfa++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }), { status: 200 });
    }
    calls.signatures++;
    const p = body.params[1];
    const start = p.before ? sigs.findIndex((s) => s.signature === p.before) + 1 : 0;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: sigs.slice(start, start + p.limit) }), { status: 200 });
  }) as typeof fetch;
  let clock = 0;
  const config: HistoryConfig = { ...HISTORY_CONFIG, helius: { ...HISTORY_CONFIG.helius, maxRequestsPerSecond: 100_000, maxRetries: 0, fallbackOldestSignaturePages: walkPages } };
  const provider = new HeliusHistoryProvider({ apiKey: "test-key", config: config.helius, fetchImpl, sleep: async (ms) => void (clock += ms), now: () => clock });
  const service = new WalletHistoryService({ providers: [provider], config });
  return { service, calls, collect: (deepAllowed = false) => collectWalletFactsFromHistory(service, W, { deepAllowed, budget: new DeepBudget(8) }) };
}

const ctx: ProfileContext = { creator: key(90), creatorFunder: null, launchTime: null, relatedTo: [], launchTimes: {}, pricesSol: {}, now: (T0 + 400_000) * 1000 };

/** GCcdKT-like: funding, 12 buy→sell positions in the OLDEST part, then plain SOL movements. */
const gcKind = (i: number): Kind => (i === 1 ? { t: "funding" } : i <= 25 ? (i % 2 === 0 ? { t: "buy", m: i / 2 } : { t: "sell", m: (i - 1) / 2, sol: i % 4 === 1 ? 0.3 : 0.9 }) : { t: "sol" });

// ─── A / I: short history completed after QUICK ──────────────────────────

test("A/I (GCcdKT-like): 109 transactions → QUICK 100 + one completion page reaches the end → complete, 12 positions, no DEEP", async () => {
  const w = wallet(109, gcKind);
  const f = await w.collect(false);
  const h = f.history!;
  assert.equal(f.historyComplete, true);
  assert.equal(h.completeness, "quick_completion_complete");
  assert.deepEqual({ attempted: h.quickCompletion.attempted, stop: h.quickCompletion.stopReason, pages: h.quickCompletion.pages }, { attempted: true, stop: "quick_completion_end", pages: 1 });
  assert.equal(h.deep.attempted, false);
  assert.equal(h.origin.totalSignatures, 109);
  assert.equal(f.trades?.length, 24);
  assert.equal(f.signatureCount, 109);
  const p = profileWallet(f, ctx, null);
  assert.equal(p.metrics?.positions.length, 12);
  assert.equal(p.metrics?.evaluated, 12);
  assert.equal(p.confidence, "MEDIUM", "existing thresholds: 12 evaluable positions → MEDIUM");
});

// ─── B / H: budget reached without the end ───────────────────────────────

test("B (401 transactions, size known): too long for QUICK completion → incomplete, no win rate / global PnL", async () => {
  const w = wallet(401, gcKind);
  const f = await w.collect(false);
  assert.equal(f.history?.origin.totalSignatures, 401);
  assert.equal(f.history?.quickCompletion.skippedReason, "history_too_long");
  assert.equal(f.historyComplete, false);
  assert.equal(f.trades, null);
  assert.equal(profileWallet(f, ctx, null).metrics, null);
});

test("H (size unknown): one probe page, budget reached before the end → quick_completion_budget, incomplete", async () => {
  const w = wallet(401, gcKind);
  w.service.cache.putOrigin({ wallet: W, firstSeen: (T0 + 60) * 1000, signature: "s1", method: "signature_walk", empty: false }); // origin known, size unknown
  const f = await w.collect(false);
  assert.equal(f.history?.origin.method, "cache");
  assert.equal(f.history?.origin.totalSignatures, null);
  assert.deepEqual([f.history?.quickCompletion.attempted, f.history?.quickCompletion.stopReason, f.history?.quickCompletion.pages], [true, "quick_completion_budget", 1]);
  assert.equal(f.historyComplete, false);
  assert.equal(f.trades, null);
});

test("DEEP behaviour unchanged: with DEEP allowed the 401-transaction wallet still completes through DEEP", async () => {
  const f = await wallet(401, gcKind).collect(true);
  assert.equal(f.history?.completeness, "deep_complete");
  assert.equal(f.history?.quickCompletion.attempted, false);
  assert.equal(f.trades?.length, 24);
});

// ─── C / E: D12R-like ────────────────────────────────────────────────────

test("C/E (D12R-like, > 10,000 signatures): no completion, bot intelligence kept, lower bound ≥ 10,000", async () => {
  // Newest 100: 33 fast buy→sell pairs (4 s apart), 1 extra sell, 33 failed; older history endless.
  const n = 15_000;
  const kind = (i: number): Kind => {
    const k = n - i; // 0 = newest
    if (k >= 100) return { t: "sol" };
    if (k % 3 === 2) return { t: "failed" };
    const pair = Math.floor(k / 3);
    return k % 3 === 0 ? { t: "sell", m: 300 + pair, sol: 0.075, tokens: 3_000_000n } : { t: "buy", m: 300 + pair, tokens: 3_000_000n };
  };
  const w = wallet(n, kind);
  const f = await w.collect(false);
  const h = f.history!;
  assert.equal(h.origin.reason, "budget_exhausted");
  assert.equal(h.origin.signaturesScanned, 10_000);
  assert.equal(h.quickCompletion.skippedReason, "history_too_long");
  assert.equal(h.quickCompletion.attempted, false);
  assert.equal(f.historyComplete, false);
  assert.ok(f.signatureCount >= 10_000);
  assert.equal(w.calls.signatures, 1 + 10, "recent page + origin walk only: no 100 → 200 → … paging");
  assert.equal(w.calls.enhanced, 1, "only the recent page was decoded");
  assert.ok(h.bot.fastRoundTrips >= 30 && h.bot.distinctTokens >= 30);
  assert.ok(profileWallet(f, ctx, null).flags.some((x) => x.key === "busy"));
});

// ─── D: 5,000 lower bound (and 68nZUu-like) ──────────────────────────────

test("D: origin walk lists 5,000 signatures without reaching the start → lower bound ≥ 5,000 → existing busy flag", async () => {
  const f = await wallet(6000, () => ({ t: "sol" }), 5).collect(false);
  assert.equal(f.history?.origin.signaturesScanned, 5000);
  assert.equal(f.signatureCount, 5000);
  const busy = profileWallet(f, ctx, null).flags.find((x) => x.key === "busy");
  assert.ok(busy && busy.severity === "medium");
});

test("D (68nZUu-like): walk reaches the start after 5,200 signatures → count ≥ 5,200 (not the 20 decoded), busy kept, no completion", async () => {
  const f = await wallet(5200, (i) => (i === 1 ? { t: "funding" } : { t: "sol" })).collect(false);
  assert.equal(f.history?.origin.found, true);
  assert.equal(f.history?.origin.signaturesScanned, 5200);
  assert.equal(f.history?.origin.totalSignatures, 5200);
  assert.ok(f.signatureCount >= 5200);
  assert.equal(f.history?.quickCompletion.skippedReason, "history_too_long");
  assert.ok(profileWallet(f, ctx, null).flags.some((x) => x.key === "busy"));
});

// ─── F / G ───────────────────────────────────────────────────────────────

test("F: failed transactions — signaturesScanned counts signatures listed (109), not transactions decoded or succeeded", async () => {
  const kind = (i: number): Kind => (i > 25 && i % 3 === 0 ? { t: "failed" } : gcKind(i));
  const w = wallet(109, kind);
  const f = await w.collect(false);
  assert.equal(f.history?.origin.signaturesScanned, 109);
  assert.equal(f.history?.origin.totalSignatures, 109);
  assert.equal(f.historyComplete, true);
  assert.equal(f.trades?.length, 24);
  assert.equal(f.signatureCount, 109, "exact size, failed included");
});

test("G: cache — a second run counts nothing twice", async () => {
  const w = wallet(109, gcKind);
  const a = await w.collect(false);
  const b = await w.collect(false);
  assert.equal(b.history?.origin.method, "cache");
  assert.equal(b.trades?.length, a.trades?.length);
  assert.equal(new Set(b.trades!.map((t) => t.signature)).size, b.trades!.length);
  assert.equal(b.signatureCount, a.signatureCount);
  assert.equal(b.historyComplete, true);
});

// ─── J ───────────────────────────────────────────────────────────────────

test("J: Quality and Confidence depend on the facts only — same complete facts, same result with or without the completion record", async () => {
  const f = await wallet(109, gcKind).collect(false);
  const { history: _h, ...plain } = f;
  const a = profileWallet(f, ctx, null);
  const b = profileWallet(plain, ctx, null);
  assert.equal(a.quality, b.quality);
  assert.equal(a.confidence, b.confidence);
  assert.deepEqual(a.flags.map((x) => x.key), b.flags.map((x) => x.key));
  assert.equal(WALLET_CONFIG.historyLayer.quickCompletion.enabled, true);
});
