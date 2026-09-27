import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { inspect } from "node:util";
import { base58Encode } from "../src/onchain/base58.ts";
import type { ParsedTransaction, SignatureInfo } from "../src/onchain/rpc.ts";
import { MemoryHistoryCache } from "../src/history/cache.ts";
import { classifyForWallet, toTrade } from "../src/history/classify.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import type { HistoryConfig } from "../src/history/config.ts";
import { HeliusHistoryProvider } from "../src/history/helius.ts";
import { normalizeEnhanced, normalizeParsed } from "../src/history/normalize.ts";
import type { EnhancedTransaction } from "../src/history/normalize.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { createServerHistoryService, readHeliusKey } from "../src/history/server/heliusEnv.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import type { HistoryLogEntry } from "../src/history/types.ts";
import { decodeTrade } from "../src/wallets/trades.ts";

const KEY = "hk-TEST-SECRET-9f8e7d6c";
const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const MINT = key(1);
const OTHER = key(2);
const CURVE = key(3);
const SENDER = key(4);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T0 = Date.UTC(2026, 8, 25, 16, 18, 37) / 1000;

const CONFIG: HistoryConfig = { ...HISTORY_CONFIG, helius: { ...HISTORY_CONFIG.helius, maxRequestsPerSecond: 100_000, maxRetries: 2 } };

// ─── fixtures ────────────────────────────────────────────────────────────

/** A full (jsonParsed) transaction: `owner` gets `tokenDelta` of `mint` and `lamportDelta` lamports; the curve the opposite. */
function fullTx(sig: string, slot: number, o: { owner?: string; mint?: string; tokenDelta?: bigint; lamportDelta?: number; programs?: string[]; signer?: boolean; extraMint?: string } = {}): ParsedTransaction {
  const owner = o.owner ?? W;
  const mint = o.mint ?? MINT;
  const td = o.tokenDelta ?? 1_000_000n;
  const ld = o.lamportDelta ?? -100_000_000;
  const bal = (who: string, m: string, amount: bigint, i: number) => ({ accountIndex: i, mint: m, owner: who, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null } });
  const pre = [bal(owner, mint, 5_000_000n, 1), bal(CURVE, mint, 900_000_000_000n, 2)];
  const post = [bal(owner, mint, 5_000_000n + td, 1), bal(CURVE, mint, 900_000_000_000n - td, 2)];
  if (o.extraMint) {
    pre.push(bal(owner, o.extraMint, 0n, 3));
    post.push(bal(owner, o.extraMint, 7n, 3));
  }
  const signer = o.signer ?? true;
  return {
    slot,
    blockTime: T0 + slot,
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: signer
          ? [{ pubkey: owner, signer: true, writable: true }, { pubkey: CURVE, signer: false, writable: true }]
          : [{ pubkey: SENDER, signer: true, writable: true }, { pubkey: owner, signer: false, writable: true }, { pubkey: CURVE, signer: false, writable: true }],
        instructions: (o.programs ?? [PUMP]).map((programId) => ({ programId })),
      },
    },
    meta: signer
      ? { err: null, fee: 5000, preBalances: [10e9, 1e9], postBalances: [10e9 + ld, 1e9 - ld], preTokenBalances: pre, postTokenBalances: post }
      : { err: null, fee: 5000, preBalances: [10e9, 1e9, 1e9], postBalances: [10e9 - 5000, 1e9, 1e9], preTokenBalances: pre, postTokenBalances: post },
  };
}

const gtfaItem = (tx: ParsedTransaction) => ({ slot: tx.slot, blockTime: tx.blockTime, transaction: tx.transaction, meta: tx.meta });

/** `n` transactions of W, newest first (slot n … 1). */
const dataset = (n: number) => Array.from({ length: n }, (_, i) => fullTx(`s${n - i}`, n - i));

function enhanced(sig: string, slot: number, o: { feePayer: string; type: string; source: string; lamports?: Record<string, number>; tokens?: Record<string, bigint>; programs: string[] }): EnhancedTransaction {
  const accounts = new Set([...Object.keys(o.lamports ?? {}), ...Object.keys(o.tokens ?? {})]);
  return {
    signature: sig,
    slot,
    timestamp: T0 + slot,
    fee: 25_777,
    feePayer: o.feePayer,
    type: o.type,
    source: o.source,
    transactionError: null,
    accountData: [...accounts].map((a) => ({
      account: a,
      nativeBalanceChange: o.lamports?.[a] ?? 0,
      tokenBalanceChanges: o.tokens?.[a] !== undefined ? [{ userAccount: a, mint: MINT, rawTokenAmount: { tokenAmount: o.tokens[a].toString(), decimals: 6 } }] : [],
    })),
    instructions: o.programs.map((programId) => ({ programId, innerInstructions: [] })),
  };
}

interface FakeReq {
  kind: "gtfa" | "signatures" | "enhanced";
  params: Record<string, unknown>;
  body: unknown;
  url: string;
}
type Reply = { status: number; body: unknown } | "throw";

/** Offline Helius: routes JSON-RPC methods and /v0/transactions to handlers. */
function fakeHelius(h: { gtfa?: (p: Record<string, unknown>, n: number) => Reply; signatures?: (p: Record<string, unknown>) => Reply; enhanced?: (sigs: string[]) => Reply }) {
  const requests: FakeReq[] = [];
  const counts = { gtfa: 0, signatures: 0, enhanced: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    let reply: Reply;
    if (url.includes("/v0/transactions")) {
      counts.enhanced++;
      requests.push({ kind: "enhanced", params: {}, body, url });
      reply = h.enhanced ? h.enhanced(body.transactions) : { status: 500, body: {} };
    } else if (body.method === "getTransactionsForAddress") {
      counts.gtfa++;
      const p = body.params[1] as Record<string, unknown>;
      requests.push({ kind: "gtfa", params: p, body, url });
      reply = h.gtfa ? h.gtfa(p, counts.gtfa) : { status: 404, body: {} };
    } else {
      counts.signatures++;
      const p = (body.params[1] ?? {}) as Record<string, unknown>;
      requests.push({ kind: "signatures", params: p, body, url });
      reply = h.signatures ? h.signatures(p) : { status: 500, body: {} };
    }
    if (reply === "throw") throw new Error(`connect ECONNRESET ${url}`);
    const payload = body.jsonrpc && reply.status === 200 ? { jsonrpc: "2.0", id: body.id, result: reply.body } : reply.body;
    return new Response(JSON.stringify(payload), { status: reply.status });
  }) as typeof fetch;
  return { fetchImpl, requests, counts };
}

/** getTransactionsForAddress over `txs` (newest first); token = offset. */
const gtfaOver = (txs: ParsedTransaction[]) => (p: Record<string, unknown>): Reply => {
  const ordered = p.sortOrder === "asc" ? [...txs].reverse() : txs;
  const start = p.paginationToken ? Number(p.paginationToken) : 0;
  const limit = Number(p.limit);
  const data = ordered.slice(start, start + limit).map(gtfaItem);
  return { status: 200, body: { data, paginationToken: start + limit < ordered.length ? String(start + limit) : null } };
};

/** Provider on a virtual clock: sleeps advance time instantly. */
function helius(fake: ReturnType<typeof fakeHelius>, log: HistoryLogEntry[] = [], sleeps: number[] = []) {
  let clock = 0;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  return new HeliusHistoryProvider({ apiKey: KEY, config: CONFIG.helius, fetchImpl: fake.fetchImpl, sleep, now: () => clock, onRequest: (e) => log.push(e) });
}

/** Offline public RPC over `txs` (newest first). */
function fakeRpc(txs: ParsedTransaction[]) {
  const calls = { signatures: 0, transaction: 0 };
  const sigs: SignatureInfo[] = txs.map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null }));
  return {
    calls,
    rpc: {
      async getSignatures(_a: string, limit: number, before?: string) {
        calls.signatures++;
        const start = before ? sigs.findIndex((s) => s.signature === before) + 1 : 0;
        return sigs.slice(start, start + limit);
      },
      async getTransaction(signature: string) {
        calls.transaction++;
        return txs.find((t) => t.transaction.signatures[0] === signature) ?? null;
      },
    },
  };
}

// ─── PRIMARY path & pagination ───────────────────────────────────────────

test("PRIMARY success: getTransactionsForAddress full/jsonParsed, no fallback call", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(30)) });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const page = await svc.getRecentHistory(W, 10);
  assert.equal(page.strategy, "helius_gtfa");
  assert.equal(page.provider, "helius");
  assert.equal(page.txs.length, 10);
  assert.equal(page.txs[0].signature, "s30");
  assert.equal(page.nextCursor, "gtfa:10");
  const p = fake.requests[0].params;
  assert.equal(p.transactionDetails, "full");
  assert.equal(p.encoding, "jsonParsed");
  assert.equal(p.sortOrder, "desc");
  assert.deepEqual(p.filters, { status: "succeeded" });
  assert.equal(fake.counts.signatures + fake.counts.enhanced, 0);
});

test("DEEP pagination: 3 distinct pages chained with paginationToken, complete, no overlap", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(250)) });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const deep = await svc.getFullHistory(W, { pageLimit: 100 });
  assert.equal(deep.stopReason, "end_of_history");
  assert.equal(deep.complete, true);
  assert.equal(deep.pagesThisRun, 3);
  assert.equal(deep.txs.length, 250);
  assert.equal(new Set(deep.txs.map((t) => t.signature)).size, 250);
  assert.deepEqual(fake.requests.map((r) => r.params.paginationToken), [undefined, "100", "200"]);
  assert.equal(deep.txs[0].signature, "s250");
  assert.equal(deep.txs[249].signature, "s1");
});

test("deduplication by signature: overlapping pages and repeated items are kept once", async () => {
  const txs = dataset(20);
  const fake = fakeHelius({
    gtfa: (p) => {
      if (!p.paginationToken) return { status: 200, body: { data: [...txs.slice(0, 10), txs[0]].map(gtfaItem), paginationToken: "x" } };
      return { status: 200, body: { data: txs.slice(5, 20).map(gtfaItem), paginationToken: null } };
    },
  });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const first = await svc.getRecentHistory(W, 11);
  assert.equal(first.txs.length, 10, "duplicate inside the page dropped");
  const deep = await svc.getFullHistory(W, { pageLimit: 100 });
  assert.equal(deep.txs.length, 20);
  assert.equal(new Set(deep.txs.map((t) => t.signature)).size, 20);
});

test("resume after interruption: saved cursor, finished pages are not fetched again (also from a snapshot)", async () => {
  const txs = dataset(250);
  let fail = true;
  const fake = fakeHelius({ gtfa: (p, n) => (fail && n >= 2 ? "throw" : gtfaOver(txs)(p)) });
  const cache = new MemoryHistoryCache();
  const svc = new WalletHistoryService({ providers: [helius(fake)], cache, config: CONFIG });
  const first = await svc.getFullHistory(W, { pageLimit: 100 });
  assert.equal(first.stopReason, "error");
  assert.equal(first.complete, false);
  assert.equal(first.txs.length, 100);
  assert.ok(first.error && !first.error.includes(KEY));
  assert.equal(cache.getState(W, "deep")?.cursor, "gtfa:100");

  // Persist, restore into a new service (as after a process restart), resume.
  fail = false;
  const restored = MemoryHistoryCache.fromSnapshot(JSON.parse(JSON.stringify(cache.snapshot())));
  const before = fake.requests.length;
  const svc2 = new WalletHistoryService({ providers: [helius(fake)], cache: restored, config: CONFIG });
  const second = await svc2.getFullHistory(W, { pageLimit: 100 });
  assert.equal(second.stopReason, "end_of_history");
  assert.equal(second.txs.length, 250);
  assert.deepEqual(fake.requests.slice(before).map((r) => r.params.paginationToken), ["100", "200"], "page 1 not re-downloaded");

  const third = await svc2.getFullHistory(W);
  assert.equal(third.stopReason, "cached");
  assert.equal(third.txs.length, 250);
  assert.equal(fake.requests.length, before + 2, "a finished history is served from cache");
});

test("maxPages stops the walk and a later call continues it", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(250)) });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const a = await svc.getFullHistory(W, { maxPages: 2, pageLimit: 100 });
  assert.equal(a.stopReason, "max_pages");
  assert.equal(a.txs.length, 200);
  assert.equal(a.complete, false);
  const b = await svc.getFullHistory(W, { maxPages: 2, pageLimit: 100 });
  assert.equal(b.stopReason, "end_of_history");
  assert.equal(b.txs.length, 250);
});

test("maxTransactions caps the history and shrinks the last page request", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(250)) });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const r = await svc.getFullHistory(W, { maxTransactions: 150, pageLimit: 100 });
  assert.equal(r.stopReason, "max_transactions");
  assert.equal(r.txs.length, 150);
  assert.deepEqual(fake.requests.map((q) => q.params.limit), [100, 50]);
});

// ─── fallbacks & retries ─────────────────────────────────────────────────

test("PRIMARY 403 → getSignaturesForAddress + enhanced decoding; PRIMARY stays off; cached signatures not re-downloaded", async () => {
  const sigs = ["e5", "e4", "e3", "e2", "e1"].map((s, i) => ({ signature: s, slot: 5 - i, blockTime: T0 + 5 - i, err: null }));
  const fake = fakeHelius({
    gtfa: () => ({ status: 403, body: { error: "This endpoint is restricted on your current plan" } }),
    signatures: (p) => {
      const start = p.before ? sigs.findIndex((s) => s.signature === p.before) + 1 : 0;
      return { status: 200, body: sigs.slice(start, start + Number(p.limit)) };
    },
    enhanced: (list) => ({ status: 200, body: list.map((s) => enhanced(s, Number(s.slice(1)), { feePayer: W, type: "SWAP", source: "PUMP_FUN", lamports: { [W]: -1e8, [CURVE]: 1e8 }, tokens: { [W]: 1_000_000n }, programs: [PUMP] })) }),
  });
  const log: HistoryLogEntry[] = [];
  const provider = helius(fake, log);
  const cache = new MemoryHistoryCache();
  cache.putTx(W, normalizeEnhanced(enhanced("e4", 4, { feePayer: W, type: "SWAP", source: "PUMP_FUN", lamports: { [W]: -1 }, programs: [PUMP] })));
  const svc = new WalletHistoryService({ providers: [provider], cache, config: CONFIG });

  const p1 = await svc.getRecentHistory(W, 3);
  assert.equal(p1.strategy, "helius_signatures_enhanced");
  assert.deepEqual(p1.txs.map((t) => t.signature), ["e5", "e4", "e3"]);
  assert.equal(p1.nextCursor, "sig:e3");
  assert.equal(provider.primaryDisabled, "forbidden");
  assert.deepEqual((fake.requests.find((r) => r.kind === "enhanced")!.body as { transactions: string[] }).transactions, ["e5", "e3"], "e4 came from the cache");
  assert.ok(log.some((e) => e.outcome === "fallback"));

  const p2 = await svc.getHistoryPage(W, { order: "desc", cursor: p1.nextCursor, limit: 3 });
  assert.deepEqual(p2.txs.map((t) => t.signature), ["e2", "e1"]);
  assert.equal(p2.nextCursor, null);
  assert.equal(fake.counts.gtfa, 1, "PRIMARY not retried after a 403");
});

test("429: retried with backoff, then success", async () => {
  const sleeps: number[] = [];
  const fake = fakeHelius({ gtfa: (p, n) => (n <= 2 ? { status: 429, body: { error: "rate limited" } } : gtfaOver(dataset(5))(p)) });
  const svc = new WalletHistoryService({ providers: [helius(fake, [], sleeps)], config: CONFIG });
  const page = await svc.getRecentHistory(W, 5);
  assert.equal(page.strategy, "helius_gtfa");
  assert.equal(fake.counts.gtfa, 3);
  assert.equal(page.calls, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
});

test("429 still failing after retries → fallback for that call only (PRIMARY not disabled)", async () => {
  const fake = fakeHelius({
    gtfa: () => ({ status: 429, body: {} }),
    signatures: () => ({ status: 200, body: [{ signature: "a1", slot: 1, blockTime: T0, err: null }] }),
    enhanced: (l) => ({ status: 200, body: l.map((s) => enhanced(s, 1, { feePayer: W, type: "TRANSFER", source: "SYSTEM_PROGRAM", lamports: { [W]: -5000 }, programs: [TOKEN] })) }),
  });
  const provider = helius(fake);
  const page = await new WalletHistoryService({ providers: [provider], config: CONFIG }).getRecentHistory(W, 10);
  assert.equal(page.strategy, "helius_signatures_enhanced");
  assert.equal(fake.counts.gtfa, 3);
  assert.equal(provider.primaryDisabled, null);
});

test("401 (key rejected) → the service falls back to the public RPC provider", async () => {
  const fake = fakeHelius({ gtfa: () => ({ status: 401, body: { error: "invalid api key" } }) });
  const { rpc } = fakeRpc(dataset(5));
  const svc = new WalletHistoryService({ providers: [helius(fake), new PublicRpcHistoryProvider(rpc, CONFIG.publicRpc)], config: CONFIG });
  const page = await svc.getRecentHistory(W, 5);
  assert.equal(page.provider, "public_rpc");
  assert.equal(page.txs.length, 5);
  assert.equal(page.failures[0].provider, "helius");
  assert.ok(!page.failures[0].message.includes(KEY));
});

test("getTransactionsForAddress 'method not found' is treated as unavailable → fallback", async () => {
  const fake = fakeHelius({
    gtfa: () => ({ status: 200, body: null }),
    signatures: () => ({ status: 200, body: [] }),
  });
  // Rewrite to a JSON-RPC error response.
  const orig = fake.fetchImpl;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "getTransactionsForAddress") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }), { status: 200 });
    return orig(input, init);
  }) as typeof fetch;
  let clock = 0;
  const provider = new HeliusHistoryProvider({ apiKey: KEY, config: CONFIG.helius, fetchImpl, sleep: async (ms) => void (clock += ms), now: () => clock });
  const page = await provider.getPage({ address: W, order: "desc", limit: 10, cursor: null });
  assert.equal(page.strategy, "helius_signatures_enhanced");
  assert.equal(provider.primaryDisabled, "unavailable");
});

// ─── QUICK / DEEP modes ──────────────────────────────────────────────────

test("QUICK: one recent page + one oldest page, wallet origin, no deep walk", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(300)) });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const q = await svc.quick(W);
  assert.equal(q.calls, 2);
  assert.deepEqual(fake.requests.map((r) => [r.params.sortOrder, r.params.limit]), [["desc", 100], ["asc", 20]]);
  assert.equal(q.recent.page.txs[0].signature, "s300");
  assert.equal(q.originPage?.txs[0].signature, "s1");
  assert.deepEqual({ found: q.origin.found, firstSeen: q.origin.firstSeen, signature: q.origin.signature, method: q.origin.method, complete: q.origin.complete, reason: q.origin.reason }, { found: true, firstSeen: (T0 + 1) * 1000, signature: "s1", method: "helius_primary_asc", complete: true, reason: "found" });
  assert.equal(q.status, "quick_complete");
  assert.equal(q.recent.complete, false);
  assert.deepEqual(q.trace, [{ phase: "recent", steps: [{ source: "helius_primary", result: "success" }] }, { phase: "origin", steps: [{ source: "helius_primary", result: "success" }] }], "PRIMARY success: no false error");
  assert.equal(svc.cache.getState(W, "deep"), undefined, "QUICK never starts a DEEP walk");
  // The origin is cached: a second QUICK costs one call.
  const again = await svc.quick(W);
  assert.equal(again.calls, 1);
  assert.equal(again.origin.method, "cache");
  assert.equal(again.origin.firstSeen, (T0 + 1) * 1000);
});

test("QUICK on the public RPC: small pages, origin only when the start is reachable", async () => {
  const { rpc, calls } = fakeRpc(dataset(40));
  const svc = new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(rpc, CONFIG.publicRpc)], config: CONFIG });
  const q = await svc.quick(W);
  assert.equal(q.recent.page.txs.length, 25, "public RPC pages are capped");
  assert.equal(q.origin.found, true);
  assert.equal(q.origin.method, "signature_walk");
  assert.equal(q.originPage?.txs[0].signature, "s1");
  assert.equal(q.originPage?.txs.length, 20);
  assert.equal(calls.transaction, 25 + 20 - 5, "transactions already fetched by the recent page are served from cache");
});

test("DEEP is limited to selected wallets per run", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(3)) });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: { ...CONFIG, deep: { ...CONFIG.deep, maxWalletsPerRun: 2 } } });
  await svc.getFullHistory(key(20));
  await svc.getFullHistory(key(21));
  await svc.getFullHistory(key(20));
  await assert.rejects(() => svc.getFullHistory(key(22)), /limited to 2 selected wallets/);
});

// ─── classification (balances, never the provider label) ─────────────────

test("Helius label TRANSFER but balances show a pump.fun buy → BUY", () => {
  const tx = normalizeEnhanced(enhanced("mis", 1, { feePayer: W, type: "TRANSFER", source: "SYSTEM_PROGRAM", lamports: { [W]: -101_539_617, [CURVE]: 98_765_431 }, tokens: { [W]: 342_270_503_680n, [CURVE]: -342_270_503_680n }, programs: ["ComputeBudget111111111111111111111111111111", TOKEN, PUMP] }));
  const c = classifyForWallet(tx, W);
  assert.equal(c.kind, "BUY");
  assert.equal(c.mint, MINT);
  assert.equal(c.tokenAmount, 342_270.50368);
  assert.equal(tx.providerHint?.type, "TRANSFER", "label kept as a hint only");
  const t = toTrade(tx, W);
  assert.equal(t?.side, "buy");
  assert.ok(Math.abs(t!.sol - 0.101539617) < 1e-12);
});

test("real TRANSFER: tokens received from another wallet, token program only → TRANSFER, not BUY", () => {
  // Creator-style distribution: the recipient did not sign, no swap program.
  const received = normalizeEnhanced(enhanced("tr1", 1, { feePayer: SENDER, type: "TRANSFER", source: "SOLANA_PROGRAM_LIBRARY", lamports: { [SENDER]: -6360 }, tokens: { [W]: 21_000_000_000_000n, [SENDER]: -21_000_000_000_000n }, programs: [TOKEN] }));
  assert.equal(classifyForWallet(received, W).kind, "TRANSFER");
  assert.equal(classifyForWallet(received, SENDER).kind, "TRANSFER", "sender paid fees but no swap program: not a sell");
  // Recipient signed and paid rent for its token account: still no swap program → TRANSFER.
  const withRent = normalizeParsed(fullTx("tr2", 2, { tokenDelta: 5_000_000n, lamportDelta: -2_044_280, programs: [TOKEN, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"] }), "helius-gtfa");
  assert.equal(classifyForWallet(withRent, W).kind, "TRANSFER");
  // Not a signer in a full transaction → TRANSFER.
  assert.equal(classifyForWallet(normalizeParsed(fullTx("tr3", 3, { signer: false }), "public-rpc"), W).kind, "TRANSFER");
  // Helius label SWAP does not make it a trade.
  const labelledSwap = normalizeEnhanced(enhanced("tr4", 4, { feePayer: SENDER, type: "SWAP", source: "JUPITER", lamports: { [SENDER]: -5000 }, tokens: { [W]: 1_000_000n, [SENDER]: -1_000_000n }, programs: [TOKEN] }));
  assert.equal(classifyForWallet(labelledSwap, W).kind, "TRANSFER");
});

test("BUY and SELL from full transactions agree with step 4 decodeTrade", () => {
  const buyTx = fullTx("b", 1, { tokenDelta: 2_000_000n, lamportDelta: -500_000_000 });
  const sellTx = fullTx("s", 2, { tokenDelta: -1_000_000n, lamportDelta: 300_000_000 });
  const buy = classifyForWallet(normalizeParsed(buyTx, "helius-gtfa"), W);
  const sell = classifyForWallet(normalizeParsed(sellTx, "public-rpc"), W);
  assert.equal(buy.kind, "BUY");
  assert.equal(sell.kind, "SELL");
  const b = decodeTrade(buyTx, W, MINT);
  const s = decodeTrade(sellTx, W, MINT);
  assert.ok(b.ok && s.ok);
  if (b.ok && s.ok) {
    assert.deepEqual(toTrade(normalizeParsed(buyTx, "helius-gtfa"), W), b.trade);
    assert.deepEqual(toTrade(normalizeParsed(sellTx, "public-rpc"), W), s.trade);
  }
});

test("UNKNOWN: multi-token route, failed transaction, fee-only transaction", () => {
  assert.equal(classifyForWallet(normalizeParsed(fullTx("m", 1, { extraMint: OTHER }), "public-rpc"), W).reason, "multi_token");
  const failed = normalizeParsed(fullTx("f", 2), "public-rpc");
  failed.failed = true;
  assert.equal(classifyForWallet(failed, W).kind, "UNKNOWN");
  const feeOnly = normalizeEnhanced(enhanced("fee", 3, { feePayer: W, type: "UNKNOWN", source: "UNKNOWN", lamports: { [W]: -25_777 }, programs: ["ComputeBudget111111111111111111111111111111"] }));
  assert.deepEqual([classifyForWallet(feeOnly, W).kind, classifyForWallet(feeOnly, W).reason], ["UNKNOWN", "no_change"]);
  const solIn = normalizeEnhanced(enhanced("fund", 4, { feePayer: SENDER, type: "TRANSFER", source: "SYSTEM_PROGRAM", lamports: { [W]: 1e9, [SENDER]: -1e9 - 5000 }, programs: ["11111111111111111111111111111111"] }));
  assert.equal(classifyForWallet(solIn, W).kind, "TRANSFER");
});

// ─── secret handling ─────────────────────────────────────────────────────

test("HELIUS_API_KEY never leaks: errors, logs, pages, cache, serialization", async () => {
  const log: HistoryLogEntry[] = [];
  const fake = fakeHelius({
    gtfa: () => "throw", // network error whose message contains the full URL (with the key)
    signatures: () => ({ status: 403, body: { error: `denied for ${"https://mainnet.helius-rpc.com/?api-key=" + KEY}` } }),
  });
  const provider = helius(fake, log);
  const { rpc } = fakeRpc(dataset(3));
  const cache = new MemoryHistoryCache();
  const svc = new WalletHistoryService({ providers: [provider, new PublicRpcHistoryProvider(rpc, CONFIG.publicRpc)], cache, config: CONFIG });
  const page = await svc.getRecentHistory(W, 3);
  const deep = await svc.getFullHistory(W);
  // A 403 on the fallback too (both strategies denied).
  const fake2 = fakeHelius({ gtfa: () => ({ status: 403, body: { error: `nope ${KEY}` } }), signatures: () => ({ status: 403, body: { error: `nope api-key=${KEY}` } }) });
  let thrown = "";
  try {
    await helius(fake2, log).getPage({ address: W, order: "desc", limit: 5, cursor: null });
  } catch (e) {
    thrown = `${(e as Error).message} ${(e as Error).stack ?? ""}`;
  }
  assert.ok(thrown.length > 0);
  assert.ok(fake.requests.every((r) => r.url.includes(KEY)), "the key is only used in the outgoing request URL");

  const surfaces = [JSON.stringify(log), JSON.stringify(page), JSON.stringify(deep), JSON.stringify(cache.snapshot()), JSON.stringify(provider), inspect(provider, { showHidden: true, depth: 5 }), String(provider), thrown];
  for (const s of surfaces) assert.ok(!s.includes(KEY), `key leaked in: ${s.slice(0, 120)}`);
});

test("server-only construction: key from HELIUS_API_KEY only, never VITE_*, refused in a browser", () => {
  assert.equal(readHeliusKey({ HELIUS_API_KEY: ` ${KEY} ` }), KEY);
  assert.equal(readHeliusKey({ VITE_HELIUS_API_KEY: KEY }), null);
  const { rpc } = fakeRpc([]);
  assert.equal(createServerHistoryService({ env: {}, rpc }).heliusEnabled, false);
  assert.equal(createServerHistoryService({ env: { HELIUS_API_KEY: KEY }, rpc }).heliusEnabled, true);

  const g = globalThis as { window?: unknown };
  g.window = {};
  try {
    assert.throws(() => new HeliusHistoryProvider({ apiKey: KEY }), /server-side only/);
    assert.throws(() => readHeliusKey({ HELIUS_API_KEY: KEY }), /server-side only/);
  } finally {
    delete g.window;
  }
  assert.throws(() => new HeliusHistoryProvider({ apiKey: "" }), /key missing/);
});

test("the browser bundle cannot reach the Helius provider or its key", () => {
  const root = new URL("../", import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, root), "utf8");
  for (const f of readdirSync(new URL("src/ui/", root))) {
    const src = read(`src/ui/${f}`);
    assert.ok(!/history\/(helius|server)/.test(src), `src/ui/${f} must not import the Helius provider`);
    assert.ok(!src.includes("HELIUS"), `src/ui/${f} must not mention the Helius key`);
  }
  const walk = (dir: string): string[] => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
  for (const f of [...walk("src/"), "vite.config.ts", "index.html"]) assert.ok(!read(f).includes("VITE_HELIUS"), `${f} must not expose the key through a VITE_ variable`);
  assert.match(read("../.gitignore"), /^\.env$/m, ".env files are ignored by git");
});

// ─── 4.1b: provider trace, recent counters, origin ───────────────────────

/** Fallback fixtures: `n` signatures newest first (ids f{n}…f1); those in `failed` are errors. */
function sigSet(n: number, failed: (i: number) => boolean = () => false): SignatureInfo[] {
  return Array.from({ length: n }, (_, k) => {
    const i = n - k;
    return { signature: `f${i}`, slot: i, blockTime: T0 + i, err: failed(i) ? { InstructionError: [0, "Custom"] } : null };
  });
}
const sigHandler = (sigs: SignatureInfo[]) => (p: Record<string, unknown>): Reply => {
  const start = p.before ? sigs.findIndex((s) => s.signature === p.before) + 1 : 0;
  return { status: 200, body: sigs.slice(start, start + Number(p.limit)) };
};
const enhancedBuys = (list: string[]): Reply => ({ status: 200, body: list.map((s) => enhanced(s, Number(s.slice(1)), { feePayer: W, type: "SWAP", source: "PUMP_FUN", lamports: { [W]: -1e8, [CURVE]: 1e8 }, tokens: { [W]: 1_000_000n }, programs: [PUMP] })) });
const jsonRpcError = (code: number, message: string): Reply => ({ status: 200, body: { __rpcError: { code, message } } });

/** fakeHelius variant that can answer a JSON-RPC error object for getTransactionsForAddress. */
function fakeHeliusRpcErr(h: Parameters<typeof fakeHelius>[0]) {
  const base = fakeHelius(h);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await base.fetchImpl(input, init);
    const body = await res.json();
    const err = body?.result?.__rpcError;
    return new Response(JSON.stringify(err ? { jsonrpc: "2.0", id: body.id, error: err } : body), { status: res.status });
  }) as typeof fetch;
  return { ...base, fetchImpl };
}

test("provider trace: PRIMARY 403 / 429 / method unavailable → fixed codes, then enhanced success", async () => {
  const sigs = sigSet(5);
  const cases: [string, () => Reply, string][] = [
    ["403", () => ({ status: 403, body: { error: "restricted on your current plan" } }), "forbidden"],
    ["429", () => ({ status: 429, body: {} }), "rate_limited"],
    ["-32601", () => jsonRpcError(-32601, "Method not found"), "method_unavailable"],
  ];
  for (const [label, gtfa, code] of cases) {
    const fake = fakeHeliusRpcErr({ gtfa, signatures: sigHandler(sigs), enhanced: enhancedBuys });
    const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
    const p1 = await svc.getRecentHistory(W, 10);
    assert.deepEqual(p1.trace, [{ source: "helius_primary", result: code }, { source: "helius_enhanced", result: "success" }], label);
    assert.equal(p1.strategy, "helius_signatures_enhanced");
    const p2 = await svc.getHistoryPage(W, { order: "desc", cursor: null, limit: 10 });
    if (label === "429") assert.equal(p2.trace[0].result, "rate_limited", "429 is not sticky: PRIMARY retried");
    else assert.deepEqual(p2.trace[0], { source: "helius_primary", result: "disabled", cause: code }, `${label}: sticky`);
    for (const s of [...p1.trace, ...p2.trace]) assert.deepEqual(Object.keys(s).filter((k) => !["source", "result", "cause"].includes(k)), [], "trace holds codes only");
  }
});

test("provider trace: Helius down entirely, public RPC answers", async () => {
  const fake = fakeHelius({ gtfa: () => ({ status: 403, body: {} }), signatures: () => ({ status: 403, body: {} }) });
  const { rpc } = fakeRpc(dataset(3));
  const svc = new WalletHistoryService({ providers: [helius(fake), new PublicRpcHistoryProvider(rpc, CONFIG.publicRpc)], config: CONFIG });
  const page = await svc.getRecentHistory(W, 3);
  assert.deepEqual(page.trace, [{ source: "helius_primary", result: "forbidden" }, { source: "helius_enhanced", result: "forbidden" }, { source: "public_rpc", result: "success" }]);
});

test("recent counters: 100 signatures, 33 failed → requested 100, succeeded 67, normalized 67 (failed never returned)", async () => {
  const sigs = sigSet(300, (i) => i > 201 && i % 3 === 0); // 204, 207 … 300: 33 failed
  const fake = fakeHelius({ gtfa: () => ({ status: 403, body: {} }), signatures: sigHandler(sigs), enhanced: enhancedBuys });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const page = await svc.getRecentHistory(W, 100);
  assert.deepEqual(page.stats, { signaturesRequested: 100, signaturesListed: 100, transactionsFetched: 67, transactionsFromCache: 0, transactionsSucceeded: 67, transactionsFailed: 33, transactionsNormalized: 67, missing: 0 });
  assert.equal(page.txs.length, 67);
  assert.equal((fake.requests.find((r) => r.kind === "enhanced")!.body as { transactions: string[] }).transactions.length, 67, "failed signatures are not decoded");
  assert.ok(page.txs.every((t) => !t.failed));
});

test("recent counters on PRIMARY: failed ones filtered server-side are reported as unknown, not zero", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(30)) });
  const page = await new WalletHistoryService({ providers: [helius(fake)], config: CONFIG }).getRecentHistory(W, 10);
  assert.equal(page.stats.transactionsFailed, null);
  assert.equal(page.stats.transactionsSucceeded, 10);
  assert.equal(page.stats.transactionsNormalized, 10);
});

test("origin via fallback on a small wallet: signature walk reaches the start", async () => {
  const sigs = sigSet(1500);
  const fake = fakeHelius({ gtfa: () => ({ status: 403, body: {} }), signatures: sigHandler(sigs), enhanced: enhancedBuys });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const q = await svc.quick(W);
  assert.deepEqual({ found: q.origin.found, signature: q.origin.signature, method: q.origin.method, complete: q.origin.complete, reason: q.origin.reason, scanned: q.origin.signaturesScanned }, { found: true, signature: "f1", method: "signature_walk", complete: true, reason: "found", scanned: 1500 });
  assert.equal(q.origin.totalSignatures, 1500, "the walk listed the whole history: its size is exact (not the 20 decoded)");
  assert.equal(q.origin.firstSeen, (T0 + 1) * 1000);
  assert.equal(q.status, "quick_complete");
  assert.deepEqual(q.trace[1], { phase: "origin", steps: [{ source: "helius_primary", result: "disabled", cause: "forbidden" }, { source: "helius_enhanced", result: "success" }] });
});

test("origin not found: > 10,000 signatures without PRIMARY → budget_exhausted, QUICK partial, recent still usable", async () => {
  // Endless history: every signature page is full.
  const fake = fakeHelius({
    gtfa: () => ({ status: 403, body: {} }),
    signatures: (p) => {
      const from = p.before ? Number(String(p.before).slice(1)) - 1 : 1_000_000;
      return { status: 200, body: Array.from({ length: Number(p.limit) }, (_, k) => ({ signature: `f${from - k}`, slot: from - k, blockTime: T0 + from - k, err: null })) };
    },
    enhanced: enhancedBuys,
  });
  const svc = new WalletHistoryService({ providers: [helius(fake)], config: CONFIG });
  const q = await svc.quick(W);
  assert.equal(q.recent.page.txs.length, 100, "recent activity is kept");
  assert.equal(q.recent.complete, false);
  assert.deepEqual({ found: q.origin.found, reason: q.origin.reason, complete: q.origin.complete, method: q.origin.method, scanned: q.origin.signaturesScanned }, { found: false, reason: "budget_exhausted", complete: false, method: "signature_walk", scanned: 10_000 });
  assert.equal(q.status, "quick_partial");
  assert.equal(fake.counts.signatures, 1 + 10, "QUICK keeps its 10-page origin budget");
  assert.equal(svc.cache.getOrigin(W), undefined, "an unknown origin is never cached");
});

test("origin lookup failing on every provider → upstream_partial, recent still returned", async () => {
  const txs = dataset(200).map((t) => normalizeParsed(t, "public-rpc"));
  const stats = { signaturesRequested: 100, signaturesListed: 100, transactionsFetched: 100, transactionsFromCache: 0, transactionsSucceeded: 100, transactionsFailed: 0, transactionsNormalized: 100, missing: 0 };
  const provider = {
    name: "public_rpc" as const,
    async getPage(req: { order: string }) {
      if (req.order === "asc") throw Object.assign(new Error("boom"), { kind: "timeout" });
      return { txs: txs.slice(0, 100), nextCursor: "sig:s101", provider: "public_rpc" as const, strategy: "public_rpc" as const, calls: 1, missing: 0, stats, trace: [{ source: "public_rpc" as const, result: "success" as const }] };
    },
  };
  const q = await new WalletHistoryService({ providers: [provider], config: CONFIG }).quick(W);
  assert.equal(q.status, "upstream_partial");
  assert.equal(q.origin.reason, "error");
  assert.equal(q.recent.page.txs.length, 100);
  assert.deepEqual(q.trace[1], { phase: "origin", steps: [{ source: "public_rpc", result: "timeout" }] });
});

test("a wallet whose whole history fits in the recent page gets its origin without an extra call", async () => {
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(12)) });
  const q = await new WalletHistoryService({ providers: [helius(fake)], config: CONFIG }).quick(W);
  assert.equal(q.recent.complete, true);
  assert.deepEqual([q.origin.found, q.origin.method, q.origin.signature, q.status], [true, "recent_page", "s1", "quick_complete"]);
  assert.equal(fake.counts.gtfa, 1);
});

test("snapshot v1 (no version, no origins) still loads; saving upgrades it to v2 with origins", async () => {
  const v1 = { txs: [normalizeParsed(fullTx("s1", 1), "public-rpc")], wallets: { [W]: ["s1"] }, states: [{ wallet: W, key: "deep", cursor: "gtfa:100", pages: 1, transactions: 1, done: false, stopReason: "max_pages", updatedAt: 0 }] };
  const cache = MemoryHistoryCache.fromSnapshot(JSON.parse(JSON.stringify(v1)));
  assert.equal(cache.getTx("s1")?.signature, "s1");
  assert.equal(cache.getState(W, "deep")?.cursor, "gtfa:100");
  assert.equal(cache.getOrigin(W), undefined);
  const fake = fakeHelius({ gtfa: gtfaOver(dataset(12)) });
  await new WalletHistoryService({ providers: [helius(fake)], cache, config: CONFIG }).quick(W);
  const v2 = cache.snapshot();
  assert.equal(v2.version, 2);
  assert.equal(v2.origins?.[0].signature, "s1");
  assert.equal(MemoryHistoryCache.fromSnapshot(JSON.parse(JSON.stringify(v2))).getOrigin(W)?.method, "recent_page");
  for (const bad of [KEY, "api-key", "helius-rpc"]) assert.ok(!JSON.stringify(v2).includes(bad));
});
