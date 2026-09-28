import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { MemoryHistoryCache } from "../src/history/cache.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import { HttpHistorySource, HISTORY_ROUTE } from "../src/history/httpSource.ts";
import { ProviderUnavailableError } from "../src/history/provider.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import type { WalletHistoryProvider } from "../src/history/types.ts";
import { createWalletHistoryApp } from "../server/app.ts";
import { SERVER_CONFIG } from "../server/config.ts";
import type { ServerConfig } from "../server/config.ts";
import { parseQuery } from "../server/guards.ts";
import { createBrowserWalletIntelService } from "../src/wallets/browserService.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import type { WalletIntel } from "../src/wallets/intel.ts";
import { WalletIntelService } from "../src/wallets/service.ts";
import { dex, H, row, W, world } from "./helpers/world.ts";
import type { World } from "./helpers/world.ts";

const SECRET = "hk-UI-TEST-SECRET-9f8e7d";
const SCONF: ServerConfig = { ...SERVER_CONFIG, rateLimit: { windowMs: 60_000, quickPerWindow: 500, deepPerWindow: 5 }, timeoutMs: 10_000 };

/** Local backend (real HTTP on 127.0.0.1, offline providers). */
async function backend(providers: WalletHistoryProvider[]) {
  const app = createWalletHistoryApp({ providers, cache: new MemoryHistoryCache(), deepToken: null, config: SCONF });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Browser-side fetch spy: records every URL; refuses anything but the history route. */
function spyFetch() {
  const urls: string[] = [];
  const f = async (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
    urls.push(url);
    if (!new URL(url).pathname.startsWith(HISTORY_ROUTE)) throw new Error(`unexpected browser request: ${url}`);
    return fetch(url, init);
  };
  return { f, urls };
}

async function viaUi(w: World, base: string) {
  const spy = spyFetch();
  const service = createBrowserWalletIntelService(w.rpc, dex, { history: { baseUrl: base, fetch: spy.f } });
  const intel = await service.analyze(row, w.onchain);
  return { intel, urls: spy.urls, service };
}

async function direct(w: World) {
  return new WalletIntelService(w.rpc, dex, WALLET_CONFIG, { history: () => new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(w.rpc, HISTORY_CONFIG.publicRpc)] }), deep: false }).analyze(row, w.onchain);
}

const tw = (intel: WalletIntel, a: string) => intel.tracked.find((t) => t.address === a)!;
const walletTargets = (w: World) => [...W, ...H].reduce((s, a) => s + (w.byTarget.get(a) ?? 0), 0);

// ─── A / B: UI → backend NEW history, buyers and structural wallets ───────

test("A/B: UI history client calls the backend NEW route for buyers and structural wallets; the browser RPC never reads wallet histories", async () => {
  const w = world();
  const b = await backend([new PublicRpcHistoryProvider(w.rpc, HISTORY_CONFIG.publicRpc)]);
  try {
    const before = walletTargets(w);
    const { intel, urls, service } = await viaUi(w, b.base);
    assert.equal(service.historyPath, "history");
    assert.equal(intel.source, "history");
    assert.equal(intel.tracked.length, 11);
    assert.ok(urls.length > 0);
    assert.ok(urls.every((u) => u.startsWith(`${b.base}${HISTORY_ROUTE}?`)));
    for (const a of [...W, ...H]) assert.ok(urls.some((u) => new URL(u).searchParams.get("address") === a && new URL(u).searchParams.get("mode") === "quick"), `quick for ${a}`);
    for (const h of H) {
      assert.equal(tw(intel, h).selectionSource, "structural");
      assert.ok(tw(intel, h).profile.facts.trades !== null, "history served by the backend");
    }
    // Wallet histories came through the backend (whose offline provider shares this fake chain);
    // the only wallet-level RPC reads are the backend's, never the OLD per-wallet path from the browser.
    assert.ok(walletTargets(w) > before);
    assert.equal(intel.analysisStatus, "complete");
  } finally {
    await b.close();
  }
});

test("C: buyer_and_structural stays deduplicated through HTTP", async () => {
  const w = world({ w0InGroup: true });
  const b = await backend([new PublicRpcHistoryProvider(w.rpc, HISTORY_CONFIG.publicRpc)]);
  try {
    const { intel, urls } = await viaUi(w, b.base);
    assert.equal(intel.tracked.length, 11);
    assert.equal(tw(intel, W[0]).selectionSource, "buyer_and_structural");
    assert.equal(intel.selection?.deduplicatedCandidates, 1);
    assert.equal(urls.filter((u) => new URL(u).searchParams.get("address") === W[0] && new URL(u).searchParams.get("mode") === "quick").length, 1, "W0 fetched once");
  } finally {
    await b.close();
  }
});

test("D/G: incomplete history stays UNKNOWN (no PnL), DEEP never requested, QUICK completion goes through the bounded completion mode", async () => {
  const w = world({ h2Long: true });
  const b = await backend([new PublicRpcHistoryProvider(w.rpc, HISTORY_CONFIG.publicRpc)]);
  try {
    const { intel, urls, service } = await viaUi(w, b.base);
    assert.equal(service.deepAllowed, false);
    const h2 = tw(intel, H[2]).profile;
    assert.equal(h2.facts.trades, null);
    assert.equal(h2.metrics, null);
    assert.equal(h2.facts.history?.completeness, "incomplete");
    assert.equal(h2.facts.history?.deep.attempted, false);
    assert.equal(h2.facts.history?.deep.skippedReason, "deep_disabled");
    assert.ok(urls.every((u) => new URL(u).searchParams.get("mode") !== "deep"));
    for (const u of urls.filter((x) => new URL(x).searchParams.get("mode") === "completion")) {
      const p = new URL(u).searchParams;
      assert.deepEqual([...p.keys()].sort(), ["address", "cursor", "mode", "pages"]);
      assert.ok(Number(p.get("pages")) <= WALLET_CONFIG.historyLayer.quickCompletion.maxAdditionalPages);
    }
    // getFullHistory is refused without any request.
    const src = new HttpHistorySource({ baseUrl: b.base, fetch: async () => { throw new Error("must not be called"); } });
    await assert.rejects(() => src.getFullHistory(), (e: any) => e.code === "deep_not_available_from_ui");
    assert.equal(src.requested.length, 0);
  } finally {
    await b.close();
  }
});

test("G: the normal UI flow builds Wallet Intelligence with DEEP off", () => {
  const w = world();
  const s = createBrowserWalletIntelService(w.rpc, dex);
  assert.equal(s.historyPath, "history");
  assert.equal(s.deepAllowed, false);
});

// ─── E / F: backend unavailable ──────────────────────────────────────────

test("E/F: backend unreachable → wallets UNKNOWN, no OLD path, no browser-side Helius or per-wallet RPC; fails fast after the first refusal", async () => {
  const w = world();
  // A port with nothing listening.
  const b = await backend([]);
  const dead = b.base;
  await b.close();
  const before = walletTargets(w);
  const { intel, urls } = await viaUi(w, dead);
  assert.equal(intel.source, "history");
  assert.equal(urls.length, 1, "one refused request, then fail-fast for the rest of the run");
  assert.ok(urls.every((u) => !/helius/i.test(u)));
  assert.equal(walletTargets(w), before, "no OLD per-wallet RPC history from the browser");
  assert.equal(intel.analysisStatus, "partial");
  assert.equal(intel.tracked.length, 11);
  for (const t of intel.tracked) {
    assert.equal(t.profile.facts.trades, null);
    assert.equal(t.profile.metrics, null, "no PnL");
    assert.equal(t.profile.facts.funder, null);
    assert.equal(t.profile.facts.failure?.kind, "network");
  }
  assert.equal(intel.historiesReconstructed, 0);
  assert.equal(intel.diagnostics.failureKinds.network, 12, "11 wallets + the deployment-associated wallet");
  assert.deepEqual(intel.diagnostics.stages.find((s) => s.stage === "creator")?.kind, "network");
});

// ─── H: structured, secret-safe errors; no arbitrary method ──────────────

test("H: backend errors are structured and never carry secrets or provider URLs; only planned modes/params are accepted", async () => {
  const failing: WalletHistoryProvider = {
    name: "helius",
    async getPage() {
      throw new ProviderUnavailableError("helius", "forbidden", `GET https://mainnet.helius-rpc.com/?api-key=${SECRET} → 403 ${SECRET}`);
    },
  };
  const b = await backend([failing]);
  try {
    const res = await fetch(`${b.base}${HISTORY_ROUTE}?address=${W[0]}&mode=quick`);
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(text).error, "upstream_unavailable");
    for (const bad of [SECRET, "helius-rpc", "api-key"]) assert.ok(!text.includes(bad), bad);
    // Through the browser client: classified error, no secret in its message.
    const src = new HttpHistorySource({ baseUrl: b.base });
    const err = await src.quick(W[0]).catch((e) => e);
    assert.ok(!String(err?.message).includes(SECRET));
    assert.deepEqual(err.failures.map((f: any) => [f.provider, f.kind]), [["helius", "forbidden"]]);

    const status = async (qs: string) => (await fetch(`${b.base}${HISTORY_ROUTE}?${qs}`)).status;
    assert.equal(await status(`address=${W[0]}&mode=getBalance`), 400);
    assert.equal(await status(`address=${W[0]}&mode=quick&method=getBalance`), 400);
    assert.equal(await status(`address=${W[0]}&mode=quick&cursor=sig:x`), 400, "cursor only with completion");
    assert.equal(await status(`address=${W[0]}&mode=completion&cursor=https://evil`), 400);
    assert.equal(await status(`address=${W[0]}&mode=completion&cursor=sig:${"1".repeat(70)}&pages=99`), 400);
    assert.equal(await status(`address=${W[0]}&mode=deep`), 403, "DEEP disabled without a server token");
    assert.equal((await fetch(`${b.base}/api/rpc`)).status, 404);
  } finally {
    await b.close();
  }
  assert.deepEqual(parseQuery(new URLSearchParams(`address=${W[0]}&mode=completion&cursor=gtfa:123:4`)), { ok: true, address: W[0], mode: "completion", cursor: "gtfa:123:4", pages: 2 });
  assert.equal((parseQuery(new URLSearchParams(`address=${W[0]}&mode=completion&cursor=gtfa:abc`)) as any).error, "invalid_cursor");
});

// ─── I / J: NEW results identical through HTTP ───────────────────────────

test("I/J: provenance, relationships, Step 3 comparison and cluster adjustment are the same through HTTP as server-side", async () => {
  for (const opts of [{}, { w0InGroup: true }, { h2Long: true }]) {
    const w = world(opts);
    const b = await backend([new PublicRpcHistoryProvider(w.rpc, HISTORY_CONFIG.publicRpc)]);
    try {
      const { intel: ui } = await viaUi(w, b.base);
      const srv = await direct(world(opts));
      const view = (i: WalletIntel) => ({
        tracked: i.tracked.map((t) => [t.address, t.selectionSource, t.structuralReasons, t.cluster, t.profile.quality, t.profile.confidence, t.profile.flags.map((f) => f.key), t.profile.facts.trades?.length ?? null, t.profile.facts.funder, t.profile.facts.history?.completeness]),
        links: i.related.links.map((l) => [l.type, l.a, l.b, l.strength]),
        groups: i.related.groups.map((g) => g.members.map((m) => m.address)),
        independent: i.independentClusters,
        comparison: (i.step3Comparison ?? []).map((c) => [c.step3.type, c.step3.a, c.step3.b, c.status]),
        selection: { ...i.selection, historyStepsBySelectionSource: undefined },
      });
      assert.deepEqual(view(ui), view(srv), JSON.stringify(opts));
    } finally {
      await b.close();
    }
  }
});

// ─── K / L: browser bundle ───────────────────────────────────────────────

test("K/L: the browser bundle holds no Helius key name, no authenticated endpoint and no server history code", async () => {
  const { build } = await import("vite");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = (await build({ root, logLevel: "silent", build: { write: false } })) as any;
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o: any) => o.output);
  const code = outputs.map((o: any) => (o.type === "chunk" ? o.code : typeof o.source === "string" ? o.source : "")).join("\n");
  assert.ok(code.length > 10_000);
  assert.ok(code.includes(HISTORY_ROUTE), "the UI history client is in the bundle");
  for (const bad of ["HELIUS_API_KEY", "helius-rpc.com", "api-key", "api.helius", "readHeliusKey", "createServerProviders", "authenticated_rpc"]) {
    assert.ok(!code.includes(bad), `bundle must not contain ${bad}`);
  }
});
