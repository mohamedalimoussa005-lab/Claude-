import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58Encode } from "../src/onchain/base58.ts";
import type { ParsedTransaction } from "../src/onchain/rpc.ts";
import { MemoryHistoryCache } from "../src/history/cache.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import type { HistoryConfig } from "../src/history/config.ts";
import { HeliusHistoryProvider } from "../src/history/helius.ts";
import { normalizeParsed } from "../src/history/normalize.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import type { HistoryPage, PageRequest, WalletHistoryProvider } from "../src/history/types.ts";
import { createWalletHistoryApp, ROUTE } from "../server/app.ts";
import type { WalletHistoryAppOptions } from "../server/app.ts";
import { SERVER_CONFIG } from "../server/config.ts";
import type { ServerConfig } from "../server/config.ts";
import { hostAllowed, isLoopback, isSolanaAddress, tokenMatches } from "../server/guards.ts";
import { FileSnapshotStore } from "../server/snapshotStore.ts";

const KEY = "hk-TEST-SECRET-server-4b3a2c1d";
const DEEP_TOKEN = "local-deep-token-for-tests";
const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const MINT = key(1);
const CURVE = key(3);
const T0 = 1_790_000_000;

const HCONF: HistoryConfig = { ...HISTORY_CONFIG, helius: { ...HISTORY_CONFIG.helius, maxRequestsPerSecond: 100_000, maxRetries: 0 } };
const SCONF: ServerConfig = { ...SERVER_CONFIG, rateLimit: { windowMs: 60_000, quickPerWindow: 50, deepPerWindow: 50 }, timeoutMs: 5_000 };

// ─── fixtures ────────────────────────────────────────────────────────────

function fullTx(sig: string, slot: number): ParsedTransaction {
  const bal = (who: string, amount: bigint, i: number) => ({ accountIndex: i, mint: MINT, owner: who, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null } });
  return {
    slot,
    blockTime: T0 + slot,
    transaction: {
      signatures: [sig],
      message: { accountKeys: [{ pubkey: W, signer: true, writable: true }, { pubkey: CURVE, signer: false, writable: true }], instructions: [{ programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" }] },
    },
    meta: { err: null, fee: 5000, preBalances: [10e9, 1e9], postBalances: [9.9e9, 1.1e9], preTokenBalances: [bal(W, 0n, 1), bal(CURVE, 1_000_000_000n, 2)], postTokenBalances: [bal(W, 1_000_000n, 1), bal(CURVE, 999_000_000n, 2)] },
  };
}
const dataset = (n: number) => Array.from({ length: n }, (_, i) => fullTx(`s${n - i}`, n - i));

/** In-memory provider over `txs` (newest first), "sig:" cursors; optional gate to hold requests. */
function memoryProvider(txs: ParsedTransaction[], hold?: () => Promise<void>) {
  const norm = txs.map((t) => normalizeParsed(t, "public-rpc"));
  const stats = { calls: 0 };
  const provider: WalletHistoryProvider = {
    name: "public_rpc",
    async getPage(req: PageRequest): Promise<HistoryPage> {
      stats.calls++;
      if (hold) await hold();
      const list = req.order === "asc" ? [...norm].reverse() : norm;
      const start = req.cursor ? list.findIndex((t) => `sig:${t.signature}` === req.cursor) + 1 : 0;
      const page = list.slice(start, start + req.limit);
      const next = start + req.limit < list.length ? `sig:${page[page.length - 1].signature}` : null;
      const pageStats = { signaturesRequested: req.limit, signaturesListed: page.length, transactionsFetched: page.length, transactionsFromCache: 0, transactionsSucceeded: page.length, transactionsFailed: 0, transactionsNormalized: page.length, missing: 0 };
      return { txs: page, nextCursor: req.order === "asc" ? null : next, provider: "public_rpc", strategy: "public_rpc", calls: 1, missing: 0, stats: pageStats, trace: [{ source: "public_rpc", result: "success" }], ...(req.order === "asc" ? { reachedStart: true, originStatus: "reached" as const } : {}) };
    },
  };
  return { provider, stats };
}

type Reply = { status: number; body: unknown };
/** Offline Helius endpoint. */
function fakeHeliusFetch(h: { gtfa: (p: Record<string, unknown>) => Reply; signatures?: (p: Record<string, unknown>) => Reply; enhanced?: (sigs: string[]) => Reply }) {
  const tokens: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    let r: Reply;
    if (String(input).includes("/v0/transactions")) {
      const e = h.enhanced ? h.enhanced(body.transactions) : { status: 500, body: {} };
      return new Response(JSON.stringify(e.body), { status: e.status });
    }
    if (body.method === "getTransactionsForAddress") {
      tokens.push(body.params[1].paginationToken);
      r = h.gtfa(body.params[1]);
    } else r = h.signatures ? h.signatures(body.params[1] ?? {}) : { status: 500, body: {} };
    const payload = r.status === 200 ? { jsonrpc: "2.0", id: body.id, result: r.body } : r.body;
    return new Response(JSON.stringify(payload), { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, tokens };
}
const heliusProvider = (fetchImpl: typeof fetch) => new HeliusHistoryProvider({ apiKey: KEY, config: HCONF.helius, fetchImpl, sleep: async () => {} });
const gtfaOver = (txs: ParsedTransaction[]) => (p: Record<string, unknown>): Reply => {
  const start = p.paginationToken ? Number(p.paginationToken) : 0;
  const limit = Number(p.limit);
  const ordered = p.sortOrder === "asc" ? [...txs].reverse() : txs;
  const data = ordered.slice(start, start + limit).map((t) => ({ slot: t.slot, blockTime: t.blockTime, transaction: t.transaction, meta: t.meta }));
  return { status: 200, body: { data, paginationToken: start + limit < ordered.length ? String(start + limit) : null } };
};

async function start(o: Partial<WalletHistoryAppOptions> & { providers: WalletHistoryProvider[] }) {
  const app = createWalletHistoryApp({ deepToken: null, cache: o.store ? undefined : new MemoryHistoryCache(), config: SCONF, historyConfig: HCONF, ...o });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { app, port, close };
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: text ? JSON.parse(text) : {} }));
    });
    req.on("error", reject);
    req.end();
  });
}
const q = (address: string, mode: string) => `${ROUTE}?address=${encodeURIComponent(address)}&mode=${encodeURIComponent(mode)}`;
const auth = { authorization: `Bearer ${DEEP_TOKEN}` };

// ─── validation ──────────────────────────────────────────────────────────

test("invalid address, invalid mode, unknown parameter, wrong method/route/host are refused", async () => {
  const { provider, stats } = memoryProvider(dataset(5));
  const s = await start({ providers: [provider] });
  try {
    for (const bad of ["abc", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", `${W}1`, base58Encode(new Uint8Array(31).fill(7)), `${W};rm`]) {
      const r = await get(s.port, q(bad, "quick"));
      assert.equal(r.status, 400, bad);
      assert.equal(r.json.error, "invalid_address");
    }
    assert.equal((await get(s.port, `${ROUTE}?address=${W}`)).json.error, "invalid_mode");
    assert.equal((await get(s.port, q(W, "full"))).json.error, "invalid_mode");
    assert.equal((await get(s.port, `${q(W, "quick")}&mode=deep`)).json.error, "invalid_mode");
    assert.equal((await get(s.port, `${q(W, "quick")}&limit=5000`)).json.error, "unknown_parameter");
    assert.equal((await get(s.port, q(W, "quick"), {}, "POST")).status, 405);
    assert.equal((await get(s.port, "/api/other")).status, 404);
    const rebinding = await get(s.port, q(W, "quick"), { host: "attacker.example:80" });
    assert.equal(rebinding.status, 403);
    assert.equal(stats.calls, 0, "nothing reached a provider");
  } finally {
    await s.close();
  }
  assert.ok(isSolanaAddress(W));
  assert.ok(isSolanaAddress("11111111111111111111111111111111"));
  assert.ok(isSolanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  assert.ok(hostAllowed("localhost:5173", SERVER_CONFIG.allowedHosts) && hostAllowed("[::1]:8787", SERVER_CONFIG.allowedHosts));
  assert.ok(!hostAllowed("localhost.evil.com", SERVER_CONFIG.allowedHosts));
  assert.ok(isLoopback("::ffff:127.0.0.1") && !isLoopback("192.168.1.20") && !isLoopback(undefined));
});

// ─── QUICK / DEEP ────────────────────────────────────────────────────────

test("QUICK: recent + oldest pages, origin, normalized transactions only", async () => {
  const { provider } = memoryProvider(dataset(300));
  const s = await start({ providers: [provider] });
  try {
    const r = await get(s.port, q(W, "quick"));
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.deepEqual(Object.keys(r.json).sort(), ["address", "completeness", "mode", "origin", "pagination", "provider", "providerTrace", "providers", "recent", "resumable", "status", "stopReason", "transactionCount", "transactions", "truncated", "warnings"]);
    assert.equal(r.json.mode, "quick");
    assert.equal(r.json.status, "quick_complete");
    assert.equal(r.json.provider, "public_rpc");
    assert.equal(r.json.transactionCount, 120);
    assert.deepEqual(r.json.completeness, { recentComplete: false, originComplete: true, historyComplete: false });
    assert.equal(r.json.stopReason, "quick_budget");
    assert.equal(r.json.resumable, false);
    const origin = r.json.origin as Record<string, unknown>;
    assert.equal(origin.found, true);
    assert.equal(origin.firstSeen, (T0 + 1) * 1000);
    assert.equal(origin.reason, "found");
    const tx = (r.json.transactions as Record<string, unknown>[])[0];
    assert.equal(tx.signature, "s300");
    assert.ok("tokenDeltas" in tx && "lamportDeltas" in tx);
  } finally {
    await s.close();
  }
});

test("DEEP with the server token: paginated, complete, not resumable", async () => {
  const { provider } = memoryProvider(dataset(250));
  const s = await start({ providers: [provider], deepToken: DEEP_TOKEN });
  try {
    const r = await get(s.port, q(W, "deep"), auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "deep_complete");
    assert.deepEqual(r.json.completeness, { recentComplete: true, originComplete: true, historyComplete: true });
    assert.equal(r.json.resumable, false);
    assert.equal(r.json.stopReason, "end_of_history");
    assert.equal(r.json.transactionCount, 250);
    assert.deepEqual(r.json.pagination, { pagesThisRun: 3, pagesTotal: 3 });
  } finally {
    await s.close();
  }
});

test("DEEP refused: disabled without a server token, forbidden without the right bearer token", async () => {
  const { provider, stats } = memoryProvider(dataset(10));
  const off = await start({ providers: [provider] });
  try {
    const r = await get(off.port, q(W, "deep"), auth);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "deep_disabled");
  } finally {
    await off.close();
  }
  const on = await start({ providers: [provider], deepToken: DEEP_TOKEN });
  try {
    assert.equal((await get(on.port, q(W, "deep"))).json.error, "deep_forbidden");
    assert.equal((await get(on.port, q(W, "deep"), { authorization: "Bearer wrong" })).json.error, "deep_forbidden");
    assert.equal((await get(on.port, q(W, "deep"), { authorization: DEEP_TOKEN })).json.error, "deep_forbidden");
  } finally {
    await on.close();
  }
  assert.equal(stats.calls, 0, "no credit spent on refused DEEP calls");
  assert.ok(tokenMatches(`Bearer ${DEEP_TOKEN}`, DEEP_TOKEN) && !tokenMatches(`Bearer ${DEEP_TOKEN}x`, DEEP_TOKEN));
});

// ─── limits ──────────────────────────────────────────────────────────────

test("rate limiting per client and mode (429 + Retry-After)", async () => {
  const { provider } = memoryProvider(dataset(5));
  const s = await start({ providers: [provider], deepToken: DEEP_TOKEN, config: { ...SCONF, rateLimit: { windowMs: 60_000, quickPerWindow: 2, deepPerWindow: 1 } } });
  try {
    assert.equal((await get(s.port, q(W, "quick"))).status, 200);
    assert.equal((await get(s.port, q(W, "quick"))).status, 200);
    const third = await get(s.port, q(W, "quick"));
    assert.equal(third.status, 429);
    assert.equal(third.json.error, "rate_limited");
    assert.ok(Number(third.headers["retry-after"]) > 0);
    assert.equal((await get(s.port, q(W, "deep"), auth)).status, 200);
    assert.equal((await get(s.port, q(W, "deep"), auth)).status, 429, "DEEP has its own, smaller budget");
  } finally {
    await s.close();
  }
});

test("concurrency cap: a second analysis is refused while one runs (503)", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { provider } = memoryProvider(dataset(5), () => held);
  const s = await start({ providers: [provider], config: { ...SCONF, maxConcurrent: 1 } });
  try {
    const first = get(s.port, q(W, "quick"));
    while (s.app.running === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await get(s.port, q(key(11), "quick"));
    assert.equal(second.status, 503);
    assert.equal(second.json.error, "busy");
    release();
    assert.equal((await first).status, 200);
  } finally {
    await s.close();
  }
});

test("timeout: 504, and the slot is held until the analysis really ends", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { provider } = memoryProvider(dataset(5), () => held);
  const s = await start({ providers: [provider], config: { ...SCONF, timeoutMs: 50, maxConcurrent: 1 } });
  try {
    const r = await get(s.port, q(W, "quick"));
    assert.equal(r.status, 504);
    assert.equal(r.json.error, "timeout");
    assert.equal(s.app.running, 1, "background work still counted");
    assert.equal((await get(s.port, q(W, "quick"))).status, 503);
    release();
    while (s.app.running > 0) await new Promise((res) => setTimeout(res, 5));
  } finally {
    await s.close();
  }
});

test("response size cap: oldest transactions dropped, truncated flag, body within the cap", async () => {
  const { provider } = memoryProvider(dataset(250));
  const s = await start({ providers: [provider], deepToken: DEEP_TOKEN, config: { ...SCONF, maxResponseBytes: 30_000 } });
  try {
    const r = await get(s.port, q(W, "deep"), auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.truncated, true);
    assert.equal(r.json.transactionCount, 250);
    const n = (r.json.transactions as unknown[]).length;
    assert.ok(n > 0 && n < 250);
    assert.ok(Buffer.byteLength(r.text) <= 30_000);
    assert.equal((r.json.transactions as { signature: string }[])[0].signature, "s250", "newest kept");
  } finally {
    await s.close();
  }
});

// ─── Helius errors ───────────────────────────────────────────────────────

test("Helius 401 / 403 / 429 → 502 with provider + error kind only, no key, no URL, no upstream message", async () => {
  const cases: [string, ReturnType<typeof fakeHeliusFetch>, string][] = [
    ["401", fakeHeliusFetch({ gtfa: () => ({ status: 401, body: { error: `bad key ${KEY}` } }) }), "auth"],
    ["403", fakeHeliusFetch({ gtfa: () => ({ status: 403, body: { error: "plan" } }), signatures: () => ({ status: 403, body: { error: `denied api-key=${KEY}` } }) }), "forbidden"],
    ["429", fakeHeliusFetch({ gtfa: () => ({ status: 429, body: {} }), signatures: () => ({ status: 429, body: { error: KEY } }) }), "rate_limit"],
  ];
  for (const [label, fake, kind] of cases) {
    const logs: string[] = [];
    const s = await start({ providers: [heliusProvider(fake.fetchImpl)], deepToken: DEEP_TOKEN, log: (e) => logs.push(JSON.stringify(e)) });
    try {
      for (const [mode, h] of [["quick", {}], ["deep", auth]] as const) {
        const r = await get(s.port, q(W, mode), h);
        assert.equal(r.status, 502, `${label} ${mode}`);
        assert.equal(r.json.error, "upstream_unavailable");
        assert.deepEqual(r.json.failures, [{ provider: "helius", kind }]);
        for (const bad of [KEY, "helius-rpc.com", "api-key", "HELIUS_API_KEY"]) assert.ok(!r.text.includes(bad), `${label}: ${bad} leaked`);
      }
      assert.ok(logs.every((l) => !l.includes(KEY)));
    } finally {
      await s.close();
    }
  }
});

test("Helius 401 with the public RPC behind it → 200 from public_rpc with a non-sensitive warning", async () => {
  const fake = fakeHeliusFetch({ gtfa: () => ({ status: 401, body: {} }) });
  const txs = dataset(5);
  const rpc = {
    getSignatures: async () => txs.map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null })),
    getTransaction: async (sig: string) => txs.find((t) => t.transaction.signatures[0] === sig) ?? null,
  };
  const s = await start({ providers: [heliusProvider(fake.fetchImpl), new PublicRpcHistoryProvider(rpc)] });
  try {
    const r = await get(s.port, q(W, "quick"));
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "public_rpc");
    assert.deepEqual((r.json.warnings as unknown[])[0], { provider: "helius", kind: "auth" });
    assert.ok(!r.text.includes(KEY));
  } finally {
    await s.close();
  }
});

// ─── persistence ─────────────────────────────────────────────────────────

test("snapshot persistence: DEEP resumes after a backend restart; the snapshot holds no secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-"));
  const file = join(dir, "cache", "wallet-history.json");
  const txs = dataset(250);
  const oneBudget = { ...SCONF, deep: { maxPages: 1, maxTransactions: 2000 } };
  try {
    const f1 = fakeHeliusFetch({ gtfa: gtfaOver(txs) });
    const a = await start({ providers: [heliusProvider(f1.fetchImpl)], store: new FileSnapshotStore(file), deepToken: DEEP_TOKEN, config: oneBudget });
    const r1 = await get(a.port, q(W, "deep"), auth);
    assert.equal(r1.json.status, "deep_partial");
    assert.equal(r1.json.resumable, true);
    assert.equal(r1.json.stopReason, "max_pages");
    await a.app.flush();
    await a.close();
    assert.ok(existsSync(file));
    const snapshot = readFileSync(file, "utf8");
    for (const bad of [KEY, "api-key", "helius-rpc.com", DEEP_TOKEN]) assert.ok(!snapshot.includes(bad), `${bad} in snapshot`);

    // New process: fresh provider, cache loaded from disk.
    const f2 = fakeHeliusFetch({ gtfa: gtfaOver(txs) });
    const b = await start({ providers: [heliusProvider(f2.fetchImpl)], store: new FileSnapshotStore(file), deepToken: DEEP_TOKEN, config: oneBudget });
    const r2 = await get(b.port, q(W, "deep"), auth);
    const r3 = await get(b.port, q(W, "deep"), auth);
    assert.deepEqual(f2.tokens, ["100", "200"], "resumed from the saved cursor, page 1 not re-downloaded");
    assert.equal(r2.json.transactionCount, 200);
    assert.equal(r3.json.status, "deep_complete");
    assert.equal(r3.json.transactionCount, 250);
    await b.app.flush();
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt snapshot is dropped, not half-loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-"));
  try {
    const file = join(dir, "s.json");
    const good = new MemoryHistoryCache();
    good.putTx(W, normalizeParsed(fullTx("s1", 1), "public-rpc"));
    new FileSnapshotStore(file).save(good);
    assert.equal(new FileSnapshotStore(file).load().size, 1, "round trip");
    for (const corrupt of ['{"txs": [', '{"txs": 1, "states": [], "wallets": {}}', "null"]) {
      writeFileSync(file, corrupt);
      assert.equal(new FileSnapshotStore(file).load().size, 0, corrupt);
    }
    assert.equal(new FileSnapshotStore(join(dir, "missing.json")).load().size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── frontend isolation ──────────────────────────────────────────────────

test("frontend: no import of the server or the Helius provider, /api proxied to loopback, no secret in the built bundle", (t) => {
  const root = new URL("../", import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, root), "utf8");
  for (const f of readdirSync(new URL("src/ui/", root))) {
    const src = read(`src/ui/${f}`);
    assert.ok(!/from\s+["'][./]*\/?server\//.test(src) && !src.includes("../../server") && !/history\/(helius|server)/.test(src), `src/ui/${f}`);
  }
  const vite = read("vite.config.ts");
  assert.match(vite, /"\/api":\s*{\s*target:\s*"http:\/\/127\.0\.0\.1:8787"/);
  assert.ok(!vite.includes("HELIUS"));
  const dist = new URL("dist/", root);
  if (!existsSync(dist)) return t.skip("no build output (run npm run build)");
  const walk = (u: URL): string[] => readdirSync(u, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : [new URL(e.name, u).pathname]));
  for (const f of walk(dist)) {
    const text = readFileSync(f, "utf8");
    for (const bad of ["HELIUS_API_KEY", "helius-rpc.com", "api-key=", "WALLET_HISTORY_DEEP_TOKEN", "HeliusHistoryProvider"]) assert.ok(!text.includes(bad), `${bad} in ${f}`);
  }
});

// ─── 4.1b: D12R-like QUICK through the API ───────────────────────────────

test("QUICK like D12R: PRIMARY 403 → enhanced; 100 listed / 67 succeeded; origin budget_exhausted; trace codes only; nothing sensitive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-"));
  const file = join(dir, "wallet-history.json");
  const upstream = `This endpoint is restricted on your current plan https://mainnet.helius-rpc.com/?api-key=${KEY}`;
  const fake = fakeHeliusFetch({
    gtfa: () => ({ status: 403, body: { error: upstream } }),
    // Endless history (> 10,000 signatures); among the newest 100, 33 failed.
    signatures: (p) => {
      const from = p.before ? Number(String(p.before).slice(1)) - 1 : 50_000;
      return { status: 200, body: Array.from({ length: Number(p.limit) }, (_, k) => ({ signature: `f${from - k}`, slot: from - k, blockTime: T0 + from - k, err: from - k > 49_901 && (from - k) % 3 === 0 ? { InstructionError: [0, "x"] } : null })) };
    },
    enhanced: (list) => ({
      status: 200,
      body: list.map((sig) => ({ signature: sig, slot: Number(sig.slice(1)), timestamp: T0 + Number(sig.slice(1)), fee: 5000, feePayer: W, type: "SWAP", source: "PUMP_FUN", transactionError: null, accountData: [{ account: W, nativeBalanceChange: -1e8, tokenBalanceChanges: [{ userAccount: W, mint: MINT, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }] }, { account: CURVE, nativeBalanceChange: 1e8, tokenBalanceChanges: [] }], instructions: [{ programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" }] })),
    }),
  });
  const logs: string[] = [];
  try {
    const s = await start({ providers: [heliusProvider(fake.fetchImpl)], store: new FileSnapshotStore(file), log: (e) => logs.push(JSON.stringify(e)) });
    const r = await get(s.port, q(W, "quick"));
    await s.app.flush();
    await s.close();
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "quick_partial");
    assert.deepEqual(r.json.providerTrace, [
      { phase: "recent", steps: [{ source: "helius_primary", result: "forbidden" }, { source: "helius_enhanced", result: "success" }] },
      { phase: "origin", steps: [{ source: "helius_primary", result: "disabled", cause: "forbidden" }, { source: "helius_enhanced", result: "success" }] },
    ]);
    assert.deepEqual(r.json.recent, { signaturesRequested: 100, signaturesListed: 100, transactionsFetched: 67, transactionsFromCache: 0, transactionsSucceeded: 67, transactionsFailed: 33, transactionsNormalized: 67, missing: 0 });
    assert.deepEqual(r.json.origin, { found: false, firstSeen: null, signature: null, method: "signature_walk", complete: false, reason: "budget_exhausted", signaturesScanned: 10_000, totalSignatures: null });
    assert.deepEqual(r.json.completeness, { recentComplete: false, originComplete: false, historyComplete: false });
    assert.equal(r.json.stopReason, "quick_budget");
    assert.equal(r.json.transactionCount, 67);
    assert.deepEqual(r.json.warnings, [], "Helius answered (through its fallback): no provider-level failure");
    const snapshot = readFileSync(file, "utf8");
    for (const surface of [r.text, snapshot, logs.join("\n")]) {
      for (const bad of [KEY, "api-key", "helius-rpc.com", "restricted", "current plan", "stack", "authorization"]) assert.ok(!surface.includes(bad), `${bad} leaked`);
    }
    assert.ok(logs.some((l) => l.includes("helius_primary:forbidden>helius_enhanced:success")), "server log carries the trace codes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("502 carries status failed and the trace codes, never the upstream message", async () => {
  const fake = fakeHeliusFetch({ gtfa: () => ({ status: 429, body: { error: `slow down ${KEY}` } }), signatures: () => ({ status: 403, body: { error: "restricted https://mainnet.helius-rpc.com" } }) });
  const s = await start({ providers: [heliusProvider(fake.fetchImpl)] });
  try {
    const r = await get(s.port, q(W, "quick"));
    assert.equal(r.status, 502);
    assert.equal(r.json.status, "failed");
    assert.deepEqual(r.json.providerTrace, [{ phase: "recent", steps: [{ source: "helius_primary", result: "rate_limited" }, { source: "helius_enhanced", result: "forbidden" }] }]);
    for (const bad of [KEY, "helius-rpc.com", "restricted", "slow down"]) assert.ok(!r.text.includes(bad));
  } finally {
    await s.close();
  }
});
