import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { inspect } from "node:util";
import { base58Encode } from "../src/onchain/base58.ts";
import { collectOnchain } from "../src/onchain/collect.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import type { OnchainConfig } from "../src/onchain/config.ts";
import type { RpcLogEntry } from "../src/onchain/rpc.ts";
import { MemoryHistoryCache } from "../src/history/cache.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import { authenticatedFetch, createServerSolanaRpc } from "../src/rpc/serverRpc.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { WalletIntelService } from "../src/wallets/service.ts";

const KEY = "hk-RPC-TEST-SECRET-7a6b5c4d";
const AUTH_HOST = "mainnet.helius-rpc.com";
const W = base58Encode(new Uint8Array(32).fill(9));
const CONF: OnchainConfig = { ...ONCHAIN_CONFIG, rpc: { ...ONCHAIN_CONFIG.rpc, maxRetries: 0, url: "https://public.example/" } };

type Behaviour = "ok" | "quota" | "timeout" | "unauthorized" | "echo_key" | "throw_url";
/** Offline JSON-RPC endpoints. `auth` / `pub` decide each call's outcome. */
function endpoints(o: { auth?: (method: string, n: number) => Behaviour; pub?: (method: string, n: number) => Behaviour } = {}) {
  const calls = { auth: [] as string[], pub: [] as string[] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    const isAuth = url.includes(AUTH_HOST);
    if (isAuth) assert.ok(url.includes(`api-key=${KEY}`), "the key is only used on the outgoing request");
    const list = isAuth ? calls.auth : calls.pub;
    list.push(body.method);
    const b = (isAuth ? o.auth : o.pub)?.(body.method, list.length) ?? "ok";
    const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    switch (b) {
      case "quota":
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 413, message: "You have used your data allowance" } }), { status: 200 });
      case "timeout":
        throw Object.assign(new Error(`connect ETIMEDOUT ${url}`), { name: "TypeError" });
      case "throw_url":
        throw new Error(`fetch failed for ${url}`);
      case "unauthorized":
        return new Response(`invalid key ${url}`, { status: 401 });
      case "echo_key":
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `bad request ${url}` } }), { status: 200 });
      default:
        if (body.method === "getSignaturesForAddress") return rpc([{ signature: `sig-${isAuth ? "a" : "p"}`, slot: 1, blockTime: 1, err: null }]);
        if (body.method === "getBalance") return rpc({ value: 42 });
        if (body.method === "getAccountInfo") return rpc({ value: null });
        return rpc(null);
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const make = (env: Record<string, string | undefined>, e = endpoints(), log: (RpcLogEntry & { provider: string })[] = []) =>
  createServerSolanaRpc({ env, config: CONF, fetchImpl: e.fetchImpl, sleep: async () => {}, onRequest: (x) => log.push(x) });

const leaks = (s: string) => s.includes(KEY) || s.includes(AUTH_HOST) || /api-key=(?!\[redacted\])/.test(s);

// ─── H / I: construction ─────────────────────────────────────────────────

test("H: no HELIUS_API_KEY → public RPC only, as before", async () => {
  const e = endpoints();
  const s = make({}, e);
  assert.equal(s.authenticated, false);
  assert.deepEqual(s.providers, ["public_rpc"]);
  assert.equal((await s.rpc.getSignatures(W, 10))[0].signature, "sig-p");
  assert.equal(e.calls.auth.length, 0);
});

test("I: HELIUS_API_KEY set → authenticated RPC first, built without exposing the key", async () => {
  const e = endpoints();
  const s = make({ HELIUS_API_KEY: KEY }, e);
  assert.equal(s.authenticated, true);
  assert.deepEqual(s.providers, ["authenticated_rpc", "public_rpc"]);
  assert.equal((await s.rpc.getSignatures(W, 10))[0].signature, "sig-a");
  assert.equal(await s.rpc.getBalanceLamports(W), 42);
  assert.deepEqual(e.calls.pub, [], "public RPC untouched while the authenticated one answers");
  assert.equal(s.rpc.url, "authenticated_rpc+public_rpc", "a label, not an endpoint");
});

test("SOLANA_RPC_URL stays for a custom endpoint but may not carry a key", () => {
  assert.throws(() => make({ SOLANA_RPC_URL: "https://rpc.example/?api-key=abc" }), /must not carry a key/);
  assert.equal(make({ SOLANA_RPC_URL: "https://rpc.example/" }).providers[0], "public_rpc");
});

// ─── failover & circuit breakers ─────────────────────────────────────────

test("authenticated quota_exhausted → one fallback to public; later calls go straight to public", async () => {
  const e = endpoints({ auth: () => "quota" });
  const s = make({ HELIUS_API_KEY: KEY }, e);
  assert.equal((await s.rpc.getSignatures(W, 10))[0].signature, "sig-p");
  assert.equal((await s.rpc.getSignatures(W, 5))[0].signature, "sig-p");
  assert.equal(e.calls.auth.length, 1, "authenticated RPC not asked again after quota");
  const d = s.rpc.diagnostics();
  assert.deepEqual(d.providers.map((p) => [p.label, p.state, p.openedBy]), [["authenticated_rpc", "unavailable_for_run", "quota_exhausted"], ["public_rpc", "healthy", null]]);
  assert.equal(d.fallbacks, 1);
});

test("transient failure → fallback for that call only; 401 disables the authenticated RPC", async () => {
  const t = endpoints({ auth: (_m, n) => (n === 1 ? "timeout" : "ok") });
  const s = make({ HELIUS_API_KEY: KEY }, t);
  assert.equal((await s.rpc.getSignatures(W, 10))[0].signature, "sig-p");
  assert.equal((await s.rpc.getSignatures(W, 5))[0].signature, "sig-a", "still healthy after a timeout");
  const u = endpoints({ auth: () => "unauthorized" });
  const s2 = make({ HELIUS_API_KEY: KEY }, u);
  await s2.rpc.getSignatures(W, 10);
  await s2.rpc.getSignatures(W, 5);
  assert.equal(u.calls.auth.length, 1);
  assert.equal(s2.rpc.diagnostics().providers[0].state, "unavailable_for_run");
});

test("both providers down: one attempt each, then fail fast (no loop, no double spam)", async () => {
  const e = endpoints({ auth: () => "quota", pub: () => "quota" });
  const s = make({ HELIUS_API_KEY: KEY }, e);
  await assert.rejects(() => s.rpc.getSignatures(W, 10));
  await assert.rejects(() => s.rpc.getTransaction("x"), /skipped/);
  assert.deepEqual([e.calls.auth.length, e.calls.pub.length], [1, 1]);
});

test("RunRpcGuard still sits on top: a WalletIntel run with both providers spent reports quota_exhausted, token FAILED, provider labels only", async () => {
  const e = endpoints({ auth: () => "quota", pub: () => "quota" });
  const s = make({ HELIUS_API_KEY: KEY }, e);
  const row: any = { pair: { tokenAddress: W, pairAddress: W, dexId: "x" } };
  const oc: any = { data: { owners: { status: "error" }, mintInfo: { status: "error" }, creator: { status: "error" }, holders: { status: "error" } } };
  const intel = await new WalletIntelService(s.rpc, { getPairsByTokenAddresses: async () => { throw new Error("offline"); } } as any, WALLET_CONFIG).analyze(row, oc);
  assert.equal(intel.analysisStatus, "failed");
  assert.equal(intel.diagnostics.tokenFatal, "quota_exhausted");
  assert.deepEqual(intel.diagnostics.rpcProviders?.map((p) => p.label), ["authenticated_rpc", "public_rpc"]);
  assert.ok(!leaks(JSON.stringify(intel)));
});

// ─── A–G: the secret never leaves the Node transport ─────────────────────

test("B/C/E/F/G: errors, step 3 sections, diagnostics, logs and serialization never carry the key or the endpoint", async () => {
  const log: (RpcLogEntry & { provider: string })[] = [];
  const e = endpoints({ auth: (m) => (m === "getAccountInfo" ? "echo_key" : m === "getBalance" ? "throw_url" : "unauthorized"), pub: () => "echo_key" });
  const s = make({ HELIUS_API_KEY: KEY }, e, log);
  const errors: string[] = [];
  for (const call of [() => s.rpc.getParsedAccount(W), () => s.rpc.getBalanceLamports(W), () => s.rpc.getSignatures(W, 1)]) {
    try {
      await call();
    } catch (err) {
      errors.push(`${(err as Error).message} ${(err as Error).stack ?? ""}`);
    }
  }
  assert.ok(errors.length >= 2);
  // Step 3 stores error messages in its sections (shown in the UI): they must be clean too.
  const data = await collectOnchain(make({ HELIUS_API_KEY: KEY }, endpoints({ auth: () => "echo_key", pub: () => "echo_key" })).rpc, { mint: W, pairAddress: W, dexId: "x" }, CONF);
  const surfaces = [...errors, JSON.stringify(data), JSON.stringify(s.rpc.diagnostics()), JSON.stringify(log), JSON.stringify(s.rpc), inspect(s.rpc, { showHidden: true, depth: 8 }), String(s.rpc)];
  for (const x of surfaces) assert.ok(!leaks(x), `leak in: ${x.slice(0, 160)}`);
  assert.deepEqual([...new Set(log.map((l) => l.provider))].sort(), ["authenticated_rpc", "public_rpc"], "logs name providers by label");
  assert.ok(s.rpc.diagnostics().providers.every((p) => p.label === "authenticated_rpc" || p.label === "public_rpc"));
});

test("authenticatedFetch: the keyed URL stays in its closure; unreachable errors carry no URL", async () => {
  const f = authenticatedFetch(KEY, (async () => { throw new Error(`getaddrinfo ENOTFOUND https://${AUTH_HOST}/?api-key=${KEY}`); }) as typeof fetch);
  await assert.rejects(() => f("ignored", { method: "POST", body: "{}" }), (err: Error) => !leaks(err.message) && /authenticated_rpc unreachable/.test(err.message));
  assert.ok(!leaks(inspect(f, { showHidden: true, depth: 8 })));
  assert.ok(!leaks(f.toString()), "no URL in the function source either");
});

test("D: history cache fed through the authenticated RPC holds no key", async () => {
  const s = make({ HELIUS_API_KEY: KEY });
  const cache = new MemoryHistoryCache();
  await new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(s.rpc)], cache }).getRecentHistory(W, 5);
  assert.ok(!leaks(JSON.stringify(cache.snapshot())));
});

test("A: the browser never reaches the server RPC module; no key or authenticated endpoint in the bundle", (t) => {
  const root = new URL("../", import.meta.url);
  for (const f of readdirSync(new URL("src/ui/", root))) {
    const src = readFileSync(new URL(`src/ui/${f}`, root), "utf8");
    assert.ok(!/rpc\/serverRpc|history\/server|history\/helius/.test(src), `src/ui/${f}`);
  }
  // The only module importing the server RPC outside server/ and scripts/ is itself.
  const walk = (dir: string): string[] => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}${d.name}/`) : [`${dir}${d.name}`]));
  const importers = walk("src/").filter((f) => f !== "src/rpc/serverRpc.ts" && readFileSync(new URL(f, root), "utf8").includes("rpc/serverRpc"));
  assert.deepEqual(importers, []);
  const dist = new URL("dist/", root);
  if (!existsSync(dist)) return t.skip("no build output");
  for (const f of walk("dist/")) {
    const text = readFileSync(new URL(f, root), "utf8");
    for (const bad of [AUTH_HOST, "authenticatedFetch", "authenticated_rpc", "HELIUS_API_KEY", "api-key="]) assert.ok(!text.includes(bad), `${bad} in ${f}`);
  }
});
