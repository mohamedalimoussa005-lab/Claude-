import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryHistoryCache } from "../../src/history/cache.ts";
import { WalletHistoryService } from "../../src/history/service.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import { addr, buy, buyCreatingAta, DEMO_START, mulberry32, sell, sellClosingAta } from "../../src/smart-money/demo/fixtures.ts";
import { budgetedFetch, allowedHostsFor, CallBudget } from "../../src/smart-money/ingest/budget.ts";
import { describeRequest, HELIUS_HOST, PUBLIC_RPC_HOST } from "../../src/smart-money/ingest/costModel.ts";
import { estimateIngest } from "../../src/smart-money/ingest/estimate.ts";
import { FixtureHistoryProvider } from "../../src/smart-money/ingest/fixtureProvider.ts";
import { checkLive, LIVE_MAX_CREDITS } from "../../src/smart-money/ingest/guard.ts";
import type { LiveRequest } from "../../src/smart-money/ingest/guard.ts";
import { ingestWallet } from "../../src/smart-money/ingest/ingest.ts";
import { createLiveService } from "../../scripts/smart-money-live.ts";
import { buildReport, formatReport } from "../../src/smart-money/ingest/report.ts";
import { analyzeWallet } from "../../src/smart-money/pnl/profile.ts";
import { fakeNetwork, KEY } from "./fakeNetwork.ts";

const W = addr(11);
const H = 3_600_000;

/** n transactions: round trips on distinct mints, one per hour. */
function history(n: number, o: { ata?: boolean } = {}): HistoryTx[] {
  const out: HistoryTx[] = [];
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const mint = addr(30 + (i % 150));
    const t = DEMO_START + i * 2 * H;
    out.push((o.ata ? buyCreatingAta : buy)(`b${String(i).padStart(4, "0")}`, t, W, mint, 1000, 1, addr(160 + (i % 60))), (o.ata ? sellClosingAta : sell)(`s${String(i).padStart(4, "0")}`, t + H, W, mint, 1000, 2, addr(160 + (i % 60))));
  }
  return out;
}
const fixtureService = (txs: HistoryTx[], o = {}) => {
  const provider = new FixtureHistoryProvider(txs, o);
  return { provider, service: new WalletHistoryService({ providers: [provider], cache: new MemoryHistoryCache() }) };
};
const hosts = allowedHostsFor({});
const rpcBody = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

// ─── cost model & allow-list ────────────────────────────────────────────

test("cost model: documented credit prices, per request kind; unknown hosts and methods are not allowed", () => {
  const h = (u: string, b: string) => describeRequest(u, b, hosts);
  assert.deepEqual(h(`https://${HELIUS_HOST}/?api-key=x`, rpcBody("getSignaturesForAddress")), { host: HELIUS_HOST, kind: "signatures", credits: 1 });
  assert.equal(h(`https://${HELIUS_HOST}/?api-key=x`, rpcBody("getTransaction"))?.credits, 1);
  assert.equal(h(`https://${PUBLIC_RPC_HOST}/`, rpcBody("getTransaction"))?.credits, 0); // not billed by Helius
  assert.equal(h(`https://${HELIUS_HOST}/`, rpcBody("getTransactionsForAddress", [W, { limit: 100, transactionDetails: "full" }]))?.credits, 10);
  assert.equal(h(`https://${HELIUS_HOST}/`, rpcBody("getTransactionsForAddress", [W, { limit: 250, transactionDetails: "full" }]))?.credits, 30);
  assert.equal(h(`https://${HELIUS_HOST}/v0/transactions?api-key=x`, JSON.stringify({ transactions: ["a"] }))?.credits, 100);
  assert.equal(h(`https://${HELIUS_HOST}/`, rpcBody("sendTransaction")), null);
  assert.equal(h(`https://${HELIUS_HOST}/`, rpcBody("getProgramAccounts")), null);
  assert.equal(h(`https://api.helius.xyz/v0/addresses/x/transactions`, "{}"), null);
  assert.equal(h(`https://evil.example/`, rpcBody("getTransaction")), null);
  assert.equal(h(`https://${PUBLIC_RPC_HOST}/v0/transactions`, JSON.stringify({ transactions: [] })), null);
  assert.equal(h(`https://${HELIUS_HOST}/`, "not json"), null);
  assert.ok(allowedHostsFor({ SOLANA_RPC_URL: "https://my-node.example/rpc" }).has("my-node.example"));
});

test("budget: counts every request, refuses the one that would exceed it WITHOUT sending it, and refuses off-list requests", async () => {
  let sent = 0;
  const inner = (async () => (sent++, new Response("{}"))) as typeof fetch;
  const b = new CallBudget({ maxCalls: 3, maxCredits: 150 });
  const f = budgetedFetch(inner, b, hosts);
  const sig = { method: "POST", body: rpcBody("getSignaturesForAddress") };
  assert.equal((await f(`https://${HELIUS_HOST}/?api-key=${KEY}`, sig)).status, 200);
  assert.equal((await f(`https://${HELIUS_HOST}/v0/transactions?api-key=${KEY}`, { method: "POST", body: JSON.stringify({ transactions: ["a"] }) })).status, 200); // 101 credits so far
  const over = await f(`https://${HELIUS_HOST}/v0/transactions?api-key=${KEY}`, { method: "POST", body: JSON.stringify({ transactions: ["b"] }) }); // would be 201 > 150
  assert.equal(over.status, 402);
  assert.equal(b.exhaustedBy, "credits");
  assert.equal(sent, 2); // the refused request never left
  assert.equal((await f("https://evil.example/", sig)).status, 403);
  assert.equal(sent, 2);
  const r = b.report();
  assert.deepEqual([r.calls, r.credits, r.refusedByBudget, r.refusedByPolicy], [2, 101, 1, 1]);
  assert.equal(JSON.stringify(r).includes(KEY), false);
  assert.equal(/api-key|https?:/.test(JSON.stringify(r)), false);

  const c = new CallBudget({ maxCalls: 1, maxCredits: 1000 });
  const g = budgetedFetch(inner, c, hosts);
  await g(`https://${PUBLIC_RPC_HOST}/`, { body: rpcBody("getTransaction") });
  assert.equal((await g(`https://${PUBLIC_RPC_HOST}/`, { body: rpcBody("getTransaction") })).status, 402);
  assert.equal(c.exhaustedBy, "calls");
  assert.throws(() => new CallBudget({ maxCalls: 0, maxCredits: 10 }), /positive/);
});

// ─── dry-run estimator ──────────────────────────────────────────────────

test("estimate: worst-case calls and credits follow the documented prices", () => {
  const e = estimateIngest({ wallets: 3, maxTransactions: 300, pageLimit: 100, maxPages: 3 });
  const by = (s: string) => e.scenarios.find((x) => x.scenario === s)!;
  assert.deepEqual([by("helius_free").calls, by("helius_free").credits], [19, 10 + 3 * 3 * 101]); // probe + 3 wallets × 3 pages × (1 signature call + 1 enhanced call)
  assert.deepEqual([by("helius_developer").calls, by("helius_developer").credits], [9, 90]);
  assert.deepEqual([by("helius_rpc").calls, by("helius_rpc").credits], [909, 909]);
  assert.deepEqual([by("public_rpc").calls, by("public_rpc").credits], [909, 0]);
  assert.equal(e.worstHelius.scenario, "helius_free");
  assert.ok(by("helius_free").shareOfFreeAllowance < 0.001);
  const capped = estimateIngest({ wallets: 1, maxTransactions: 1000, pageLimit: 100, maxPages: 1 });
  assert.equal(capped.txPerWallet, 100); // maxPages caps the work
});

// ─── live guard ─────────────────────────────────────────────────────────

const ok: LiveRequest = { wallets: [W], provider: "helius-rpc", maxCredits: 500, maxCalls: 500, maxTransactions: 200, maxPages: 3, pageLimit: 100, ackNoAutoscale: true, heliusKeyPresent: true };
const LIVE_ENV = { SMART_MONEY_LIVE_OK: "yes" };

test("live guard: every condition is required", () => {
  assert.equal(checkLive(ok, LIVE_ENV).ok, true);
  const refused = (r: Partial<LiveRequest>, env: Record<string, string | undefined> = LIVE_ENV) => checkLive({ ...ok, ...r }, env);
  assert.ok(refused({}, {}).errors.some((e) => /SMART_MONEY_LIVE_OK/.test(e)));
  assert.ok(refused({ maxCredits: null }).errors.some((e) => /max-credits/.test(e)));
  assert.ok(refused({ maxCalls: null }).errors.some((e) => /max-calls/.test(e)));
  assert.ok(refused({ ackNoAutoscale: false }).errors.some((e) => /autoscal/i.test(e)));
  assert.ok(refused({ wallets: [addr(1), addr(2), addr(3), addr(4)] }).errors.some((e) => /3 wallets/.test(e)));
  assert.ok(refused({ wallets: [W, W] }).errors.some((e) => /double/.test(e)));
  assert.ok(refused({ wallets: ["not-a-wallet"] }).errors.some((e) => /invalide/.test(e)));
  assert.ok(refused({ maxCredits: LIVE_MAX_CREDITS + 1 }).errors.some((e) => /ne peut pas dépasser/.test(e)));
  assert.ok(refused({ pageLimit: 101 }).errors.some((e) => /page-limit/.test(e)));
  assert.ok(refused({ maxTransactions: 1001 }).errors.some((e) => /max-tx/.test(e)));
  assert.ok(refused({ heliusKeyPresent: false }).errors.some((e) => /HELIUS_API_KEY/.test(e)));
  assert.equal(refused({ heliusKeyPresent: false, provider: "public" }).ok, true);
  assert.ok(refused({ maxCredits: 50 }).warnings.some((w) => /TRONQU/.test(w)));
});

// ─── ingestion: completeness is never invented ──────────────────────────

test("ingestion: a history is COMPLETE only when the provider reports its end", async () => {
  const txs = history(50);
  const { service } = fixtureService(txs, { maxPageSize: 10 });
  const full = await ingestWallet(service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 10 });
  assert.deepEqual([full.complete, full.stopReason, full.pages, full.txs.length], [true, "end_of_history", 5, 50]);

  const byPages = await ingestWallet(fixtureService(txs).service, W, { maxPages: 2, maxTransactions: 1000, pageLimit: 10 });
  assert.deepEqual([byPages.complete, byPages.stopReason, byPages.txs.length], [false, "max_pages", 20]);

  const byTx = await ingestWallet(fixtureService(txs).service, W, { maxPages: 50, maxTransactions: 15, pageLimit: 10 });
  assert.deepEqual([byTx.complete, byTx.stopReason, byTx.txs.length], [false, "max_transactions", 15]);

  const trusted = await ingestWallet(fixtureService(txs).service, W, { maxPages: 50, maxTransactions: 1000, pageLimit: 100, historyEndTrusted: false });
  assert.deepEqual([trusted.complete, trusted.stopReason], [false, "source_not_guaranteed"]);
});

test("ingestion: a hole (listed but unretrievable transaction) makes the history incomplete even at the end", async () => {
  const txs = history(20);
  const holes = new Set([txs[3].signature, txs[8].signature]);
  const r = await ingestWallet(fixtureService(txs, { unretrievable: holes }).service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 100 });
  assert.deepEqual([r.complete, r.stopReason, r.missing, r.txs.length], [false, "missing_transactions", 2, 18]);
  assert.ok(r.notes.some((n) => /trous/.test(n)));
});

test("ingestion: provider failure and a stuck cursor stop the run and keep what was fetched", async () => {
  const txs = history(40);
  const failing = await ingestWallet(fixtureService(txs, { failFromCall: 2, maxPageSize: 10 }).service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 10 });
  assert.deepEqual([failing.complete, failing.stopReason, failing.txs.length], [false, "error", 10]);
  assert.ok(failing.failureKinds.includes("network"));
  const stuck = await ingestWallet(fixtureService(txs, { stall: true, maxPageSize: 10 }).service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 10 });
  assert.deepEqual([stuck.complete, stuck.stopReason], [false, "stalled"]);
});

test("ingestion: cached transactions are not downloaded again", async () => {
  const { provider, service } = fixtureService(history(30), { maxPageSize: 10 });
  const first = await ingestWallet(service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 10 });
  const before = provider.downloaded;
  const second = await ingestWallet(service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 10 });
  assert.equal(before, 30);
  assert.equal(provider.downloaded, 30); // nothing new downloaded
  assert.deepEqual([second.downloaded, second.fromCache, second.complete, second.txs.length], [0, 30, true, 30]);
  assert.equal(first.downloaded, 30);
});

test("property: complete ⇒ every transaction was collected; fewer collected ⇒ never complete", async () => {
  const rnd = mulberry32(5);
  const txs = history(60);
  for (let i = 0; i < 150; i++) {
    const o = { maxPages: 1 + Math.floor(rnd() * 8), maxTransactions: 5 + Math.floor(rnd() * 80), pageLimit: 5 + Math.floor(rnd() * 30) };
    const holes = rnd() < 0.3 ? new Set([txs[Math.floor(rnd() * txs.length)].signature]) : undefined;
    const r = await ingestWallet(fixtureService(txs, { unretrievable: holes, maxPageSize: 7 }).service, W, { ...o, historyEndTrusted: rnd() < 0.8 });
    if (r.complete) assert.ok(r.txs.length === 60 && r.missing === 0 && r.stopReason === "end_of_history", JSON.stringify(o));
    if (r.txs.length < 60) assert.equal(r.complete, false, JSON.stringify(o));
  }
});

test("a truncated history never produces KNOWN positions; a complete one does", async () => {
  const txs = history(40);
  const analyse = async (maxPages: number) => {
    const ing = await ingestWallet(fixtureService(txs).service, W, { maxPages, maxTransactions: 1000, pageLimit: 10 });
    return { ing, ...analyzeWallet(W, ing.txs, { coverage: { complete: ing.complete, oldestTime: ing.oldestTime } }) };
  };
  const cut = await analyse(2);
  assert.equal(cut.profile.counts.known, 0);
  assert.ok(cut.profile.counts.provisional > 0);
  const whole = await analyse(10);
  assert.equal(whole.profile.counts.known, 20);
  assert.equal(whole.profile.counts.provisional, 0);
});

// ─── report ─────────────────────────────────────────────────────────────

test("report: transaction and trade counts, PnL buckets, evidence signatures, and no label", async () => {
  const ing = await ingestWallet(fixtureService(history(40)).service, W, { maxPages: 10, maxTransactions: 1000, pageLimit: 100 });
  const a = analyzeWallet(W, ing.txs, { coverage: { complete: ing.complete, oldestTime: ing.oldestTime } });
  const r = buildReport({ ingest: ing, ledger: a.ledger, pnl: a.pnl, profile: a.profile, source: "demo", budget: null });
  assert.deepEqual([r.trades.buys, r.trades.sells, r.pnl.known, r.pnl.unknown, r.transactions.used], [20, 20, 20, 0, 40]);
  assert.equal(r.evidence.signaturesUsed, 40);
  const proof = new Set(r.evidence.rounds.flatMap((x) => x.signatures));
  for (const t of ing.txs) assert.ok(proof.has(t.signature), `signature ${t.signature} is kept as evidence`);
  assert.equal(r.label, null);
  const text = formatReport(r);
  assert.match(text, /COMPLET/);
  assert.match(text, /Étiquette : aucune/);
  assert.ok(!/"smart"|smart wallet/i.test(JSON.stringify(r) + text));
  const cutIng = await ingestWallet(fixtureService(history(40)).service, W, { maxPages: 1, maxTransactions: 1000, pageLimit: 10 });
  const b = analyzeWallet(W, cutIng.txs, { coverage: { complete: false, oldestTime: cutIng.oldestTime } });
  assert.match(formatReport(buildReport({ ingest: cutIng, ledger: b.ledger, pnl: b.pnl, profile: b.profile, source: "demo", budget: null })), /TRONQUÉ/);
});

// ─── through the real providers, against a fake network ─────────────────

const live = (net: ReturnType<typeof fakeNetwork>, provider: "auto" | "helius" | "helius-rpc" | "public", budget: CallBudget, cache = new MemoryHistoryCache(), env: Record<string, string | undefined> = { HELIUS_API_KEY: KEY }) =>
  createLiveService({ env, budget, provider, cache, pageLimit: 100, fetchImpl: net.fetchImpl, testRates: { heliusPerSecond: 100_000, rpcPerWindow: 100_000 } });
const OPEN = { maxPages: 5, maxTransactions: 1000, pageLimit: 100 };

test("Helius Free plan: the primary method is refused once, then signatures + enhanced decoding; credits match the estimate", async () => {
  const net = fakeNetwork({ [W]: history(150) });
  const budget = new CallBudget({ maxCalls: 50, maxCredits: 1000 });
  const svc = live(net, "helius", budget);
  const r = await ingestWallet(svc.service, W, { ...OPEN, budget });
  assert.deepEqual([r.complete, r.txs.length, r.pages], [true, 150, 2]);
  assert.deepEqual([net.count("gtfa"), net.count("signatures"), net.count("enhanced")], [1, 2, 2]);
  const est = estimateIngest({ wallets: 1, maxTransactions: 150, pageLimit: 100, maxPages: 5 }).scenarios.find((s) => s.scenario === "helius_free")!;
  assert.equal(budget.report().credits, est.credits);
  assert.equal(budget.report().calls, est.calls);
  assert.ok(r.trace.some((t) => t.source === "helius_primary" && t.result === "forbidden"), "the missing right is reported, not hidden");
  assert.equal(JSON.stringify(r).includes(KEY), false);
});

test("RPC path (Free plan): ≈1 credit per transaction, complete signers, so ATA rent is attributed and positions are KNOWN", async () => {
  const txs = history(60, { ata: true });
  const viaRpc = fakeNetwork({ [W]: txs });
  const b1 = new CallBudget({ maxCalls: 500, maxCredits: 500 });
  const r1 = await ingestWallet(live(viaRpc, "helius-rpc", b1).service, W, { ...OPEN, budget: b1 });
  assert.equal(r1.complete, true);
  assert.equal(b1.report().credits, 1 + 60); // one signature page + one getTransaction per transaction
  assert.equal(analyzeWallet(W, r1.txs, { coverage: { complete: true, oldestTime: r1.oldestTime } }).profile.counts.known, 30);

  const viaEnhanced = fakeNetwork({ [W]: txs });
  const b2 = new CallBudget({ maxCalls: 500, maxCredits: 1000 });
  const r2 = await ingestWallet(live(viaEnhanced, "helius", b2).service, W, { ...OPEN, budget: b2 });
  assert.equal(r2.complete, true);
  const enh = analyzeWallet(W, r2.txs, { coverage: { complete: true, oldestTime: r2.oldestTime } }).profile.counts;
  assert.equal(enh.known, 0); // enhanced decoding hides co-signers: rent cannot be attributed with certainty
  assert.equal(enh.partial, 30);
});

test("budget exhaustion truncates the history, declares it, and never goes over the cap", async () => {
  const net = fakeNetwork({ [W]: history(150) });
  const budget = new CallBudget({ maxCalls: 1000, maxCredits: 150 });
  const r = await ingestWallet(live(net, "helius-rpc", budget).service, W, { ...OPEN, maxPages: 30, budget, pageCost: (n) => ({ calls: 1 + n, credits: 1 + n }) });
  assert.deepEqual([r.complete, r.stopReason], [false, "budget_exhausted"]);
  assert.ok(r.txs.length > 100 && r.txs.length < 150);
  assert.ok(budget.report().credits <= 150);
  assert.equal(net.seen.length, budget.report().calls); // everything sent was counted
  assert.equal(budget.report().refusedByBudget, 0); // the page was shrunk before asking, nothing was refused mid-page
});

test("a hard call cap stops the run even when pages are not shrunk", async () => {
  const net = fakeNetwork({ [W]: history(150) });
  const budget = new CallBudget({ maxCalls: 20, maxCredits: 1000 });
  const r = await ingestWallet(live(net, "helius-rpc", budget).service, W, { ...OPEN, budget });
  assert.equal(r.complete, false);
  assert.equal(r.stopReason, "budget_exhausted");
  assert.ok(net.seen.length <= 20);
  assert.equal(budget.report().exhaustedBy, "calls");
});

test("a rejected key (401) stops at once: no second request, reported as an auth failure", async () => {
  const net = fakeNetwork({ [W]: history(20) }, { unauthorized: true });
  const budget = new CallBudget({ maxCalls: 50, maxCredits: 1000 });
  const r = await ingestWallet(live(net, "helius", budget).service, W, { ...OPEN, budget });
  assert.deepEqual([r.complete, r.stopReason, r.txs.length], [false, "error", 0]);
  assert.ok(r.failureKinds.includes("auth"));
  assert.equal(net.seen.length, 1);
});

test("a second run on the same cache re-lists signatures but downloads no transaction again", async () => {
  const net = fakeNetwork({ [W]: history(60) });
  const cache = new MemoryHistoryCache();
  const b1 = new CallBudget({ maxCalls: 500, maxCredits: 500 });
  await ingestWallet(live(net, "helius-rpc", b1, cache).service, W, { ...OPEN, budget: b1 });
  const b2 = new CallBudget({ maxCalls: 500, maxCredits: 500 });
  const r = await ingestWallet(live(net, "helius-rpc", b2, cache).service, W, { ...OPEN, budget: b2 });
  assert.equal(r.complete, true);
  assert.equal(b2.report().credits, 1); // a single signature page
  assert.equal(r.fromCache, 60);
});

test("public provider only: zero Helius credits, even with a key in the environment", async () => {
  const net = fakeNetwork({ [W]: history(30) });
  const budget = new CallBudget({ maxCalls: 500, maxCredits: 0 });
  const r = await ingestWallet(live(net, "public", budget).service, W, { ...OPEN, pageLimit: 25, budget });
  assert.equal(r.complete, true);
  assert.equal(budget.report().credits, 0);
  assert.ok(net.seen.every((s) => s.host === PUBLIC_RPC_HOST));
});

test("helius-rpc without a key is an error, never a silent switch to another provider", () => {
  assert.throws(() => live(fakeNetwork({}), "helius-rpc", new CallBudget({ maxCalls: 5, maxCredits: 5 }), new MemoryHistoryCache(), {}), /HELIUS_API_KEY/);
});
