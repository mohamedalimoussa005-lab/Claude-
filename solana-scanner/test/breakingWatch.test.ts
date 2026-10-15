import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatedNotifier } from "../src/detective/breaking-signal/index.ts";
import { DEFAULT_WATCH, DEFAULT_TERMS, PoliteFeedClient, SIM_TICKS, StateStore, WATCH_FEEDS, Watcher, createSimulation, scoreArticle, verifyNews } from "../src/detective/breaking-signal/watch/index.ts";
import type { FeedFetcher, WatchDeps } from "../src/detective/breaking-signal/watch/index.ts";
import { FAKE_MINT, TRUMP_MINT } from "../src/detective/breaking-signal/sources.ts";
import type { Article } from "../src/detective/social-radar/types.ts";
import type { DetectiveBrief, OnchainQuick } from "../src/detective/breaking-signal/types.ts";

const valid = (mint: string, state: OnchainQuick["state"] = "valid_mint"): OnchainQuick => ({ mint, state, program: "Tokenkeg", supply: "1", decimals: 6, mintAuthority: null, freezeAuthority: null, pools: [], reason: null });
const brief = (mint: string): DetectiveBrief => ({ mint, mode: "rapide", calls: 5, elapsedMs: 10, limitsReached: [], status: "done", reason: null, findings: [{ level: "FAIT", text: "ok" }] });
const art = (o: Partial<Article>): Article => ({ id: o.title ?? "x", title: "t", norm: "t", url: "https://e.test/a", publisher: "P", feed: "decrypt", publishedAt: 0, summary: "", ...o });

function simWatcher(over: Partial<WatchDeps> = {}, cfg: Partial<typeof DEFAULT_WATCH> = {}, statePath: string | null = null) {
  const sim = createSimulation();
  const store = new StateStore(statePath, sim.now);
  const notifier = new SimulatedNotifier("test", sim.now);
  const order: string[] = [];
  const send = notifier.send.bind(notifier);
  notifier.send = async (t) => (order.push(/ALERTE 2\/2/.test(t) ? "alert2" : /DÉGRADÉE/.test(t) ? "degraded" : "alert1"), send(t));
  const w = new Watcher({ ...DEFAULT_WATCH, fastCheckMs: 300, ...cfg }, { fetch: sim.fetch, notifier, store, now: sim.now, provenance: "simulation", checkMint: async (m) => valid(m), detective: async (m) => (order.push("detective"), brief(m)), ...over });
  return { w, sim, notifier, order, store };
}
async function runSim(h: ReturnType<typeof simWatcher>, from = 0, to = SIM_TICKS) {
  const ticks = [];
  for (let i = from; i < to; i++) {
    ticks.push(await h.w.tick());
    await h.w.drain();
    h.sim.advance();
  }
  return ticks;
}

test("relevance: priority person + crypto/launch wording, or an address with crypto context; not generic news", () => {
  assert.equal(scoreArticle({ title: "Trump team teases new memecoin launch", summary: "", url: "https://e.test" }).relevant, true);
  assert.equal(scoreArticle({ title: "Trump team teases new memecoin launch", summary: "", url: "https://e.test" }).priority, true);
  assert.equal(scoreArticle({ title: "Central bank holds rates", summary: "inflation data", url: "https://e.test" }).relevant, false);
  assert.equal(scoreArticle({ title: "Trump signs trade deal with Japan", summary: "tariffs", url: "https://e.test" }).relevant, false, "a person alone is not enough");
  assert.equal(scoreArticle({ title: "New Solana token live", summary: `CA ${TRUMP_MINT}`, url: "https://e.test" }).relevant, true);
  assert.equal(scoreArticle({ title: "Weather today", summary: `id ${TRUMP_MINT}`, url: "https://e.test" }).relevant, false, "an address without crypto context is not relevant");
  assert.equal(scoreArticle({ title: "Company X announces new meme coin airdrop", summary: "", url: "https://e.test" }).relevant, true);
});

test("verification levels: single report → NON VÉRIFIÉ; two publishers → PROBABLE; official source citing a valid mint → CONFIRMÉ; press-only address never CONFIRMÉ", async () => {
  const base = { feedClass: (id: string) => WATCH_FEEDS.find((f) => f.id === id)?.class, terms: DEFAULT_TERMS };
  const one = await verifyNews({ ...base, articles: [art({ publisher: "A" })] });
  assert.equal(one.level, "NON VÉRIFIÉ");
  const two = await verifyNews({ ...base, articles: [art({ publisher: "A", id: "1" }), art({ publisher: "B", id: "2" })] });
  assert.equal(two.level, "PROBABLE");
  assert.equal(two.basis, "recoupement presse");
  const sameTwice = await verifyNews({ ...base, articles: [art({ publisher: "A", id: "1" }), art({ publisher: "a", id: "2" })] });
  assert.equal(sameTwice.level, "NON VÉRIFIÉ", "the same publisher twice is not independent corroboration");
  const press = await verifyNews({ ...base, checkMint: async (m) => valid(m), articles: [art({ publisher: "A", id: "1", summary: `CA ${TRUMP_MINT}` }), art({ publisher: "B", id: "2", summary: `CA ${TRUMP_MINT}` })] });
  assert.equal(press.level, "PROBABLE");
  assert.equal(press.addressOfficial, false);
  assert.ok(press.notes.some((n) => /presse seulement/.test(n)));
  const official = await verifyNews({ ...base, checkMint: async (m) => valid(m), articles: [art({ publisher: "Solana Foundation", feed: "solana-news", summary: `Official contract ${TRUMP_MINT}` })] });
  assert.equal(official.level, "CONFIRMÉ");
  assert.equal(official.basis, "source officielle");
  const notMint = await verifyNews({ ...base, checkMint: async (m) => valid(m, "not_a_mint"), articles: [art({ publisher: "Solana Foundation", feed: "solana-news", summary: `Official contract ${TRUMP_MINT}` })] });
  assert.equal(notMint.level, "PROBABLE", "an official source with a non-mint address is never CONFIRMÉ");
  const ambiguous = await verifyNews({ ...base, checkMint: async (m) => valid(m), articles: [art({ publisher: "Solana Foundation", feed: "solana-news", summary: `a ${TRUMP_MINT} b ${FAKE_MINT}` })] });
  assert.equal(ambiguous.address, null);
  assert.notEqual(ambiguous.level, "CONFIRMÉ");
});

test("simulated watch: baseline silent → rumour ignored → PROBABLE alert once → no repeat → CONFIRMÉ update + enquiry → name-only token never alerted", async () => {
  const h = simWatcher();
  const ticks = await runSim(h);
  assert.equal(ticks[0]!.baseline, true);
  assert.equal(ticks[0]!.alerts.length, 0, "old relevant article read at start-up is not alerted");
  assert.equal(ticks[2]!.alerts.length, 0, "single press report: wait for corroboration");
  assert.ok(ticks[2]!.ignored.some((i) => /en attente de recoupement/.test(i.reason)));
  assert.equal(ticks[3]!.alerts.length, 1);
  assert.equal(ticks[3]!.alerts[0]!.signal.verification.level, "PROBABLE");
  assert.equal(ticks[3]!.alerts[0]!.detective, null, "no address → no enquiry");
  assert.equal(ticks[4]!.alerts.length, 1);
  assert.equal(ticks[4]!.alerts[0]!.signal.kind, "update");
  assert.equal(ticks[4]!.alerts[0]!.signal.verification.level, "CONFIRMÉ");
  assert.equal(ticks[5]!.alerts.length, 0, "no repetition once the story is alerted at its highest level");
  assert.equal(ticks[6]!.alerts.length, 0, "a token that merely uses the Trump name (single report) is not alerted");
  assert.ok(ticks[6]!.ignored.some((i) => /Trump Inu/.test(i.title)));
  assert.equal(ticks[7]!.alerts.length, 0);
  assert.deepEqual(h.order, ["alert1", "alert1", "detective", "alert2"], "alert 1 always precedes the enquiry, alert 2 follows it");
  assert.equal(h.w.results.filter((r) => r.alert2).length, 1);
});

test("alert wording: official confirmation, press-only status and name-only homonyms are clearly distinguished", async () => {
  const hom = async () => [{ mint: FAKE_MINT, name: "TRUMP INU", symbol: "TINU", liquidityUsd: 500, url: null }];
  const h = simWatcher({ findHomonyms: hom });
  await runSim(h);
  const texts = h.notifier.outbox.map((o) => o.text);
  assert.match(texts[0]!, /PROBABLE \(recoupement presse\)/);
  assert.match(texts[0]!, /NON confirmée par une source officielle/);
  assert.match(texts[0]!, /Tokens au nom proche \(NON OFFICIELS, aucun lien établi/);
  assert.match(texts[1]!, /CONFIRMÉ \(source officielle\)/);
  assert.match(texts[1]!, /annonce confirmée par une source officielle \(Solana Foundation\)/);
  assert.match(texts[1]!, /confirmation officielle: OUI/);
  for (const t of texts) {
    assert.match(t, /ni une recommandation d'investissement/);
    assert.doesNotMatch(t.replace(/ni une recommandation d'investissement ni une garantie/, ""), /acheter|achetez|buy now|garanti|to the moon/i);
    assert.match(t, /SIMULATION/);
  }
});

test("no duplicates after a restart: seen articles and alerted stories are persisted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-"));
  const path = join(dir, "state.json");
  const first = simWatcher({}, {}, path);
  await runSim(first, 0, 4); // through the PROBABLE alert (cycle 3)
  assert.equal(first.w.results.length, 1);
  const second = simWatcher({}, {}, path); // "restart": new process, same state file, same simulated world
  for (let i = 0; i < 4; i++) second.sim.advance(); // the world is at cycle 4
  const ticks = await runSim(second, 4, SIM_TICKS);
  assert.deepEqual(ticks[0]!.alerts.map((a) => a.signal.kind), ["update"], "after the restart the first alert is the upgrade, not a repeat of the PROBABLE alert");
  assert.equal(ticks.flatMap((t) => t.alerts).filter((a) => a.signal.kind === "new").length, 0);
  assert.equal(ticks.flatMap((t) => t.alerts).filter((a) => a.signal.kind === "update").length, 1, "the upgrade to CONFIRMÉ still arrives, once");
  assert.equal(new StateStore(path, second.sim.now).state.alerts.length, 1);
});

test("corrupt state file never crashes the watcher; the baseline pass prevents an alert flood", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "{not json");
  const h = simWatcher({}, {}, path);
  const t = await h.w.tick();
  assert.equal(t.baseline, true);
});

test("old news at first reading is ignored (maxAge), and a burst is capped per hour with the reason shown", async () => {
  const h = simWatcher({}, { maxAgeMs: 10_000 });
  const ticks = await runSim(h);
  assert.equal(ticks.flatMap((t) => t.alerts).length, 0, "everything is older than 10 s at first reading");
  const capped = simWatcher({}, { maxAlertsPerHour: 1 });
  const t2 = await runSim(capped);
  assert.equal(t2.flatMap((t) => t.alerts).length, 1);
  assert.ok(t2.flatMap((t) => t.suppressed).some((s) => /limite de 1 alertes\/heure/.test(s)));
});

test("sources down: the watcher is BLIND (unknown), never 'nothing to report'; one degraded notice per 6 h; the loop survives", async () => {
  const down: FeedFetcher = async () => { throw new Error("ECONNRESET"); };
  const sim = createSimulation();
  const notifier = new SimulatedNotifier("t", sim.now);
  const w = new Watcher({ ...DEFAULT_WATCH, degradedAfter: 3 }, { fetch: down, notifier, store: new StateStore(null), now: sim.now });
  const out = [];
  for (let i = 0; i < 16; i++) {
    out.push(await w.tick());
    for (let k = 0; k < 30; k++) sim.advance(); // 30 min per step: back-off windows elapse
  }
  assert.ok(out[0]!.blind);
  assert.equal(out.flatMap((t) => t.alerts).length, 0);
  const notices = notifier.outbox.filter((o) => /DÉGRADÉE/.test(o.text));
  assert.equal(notices.length, 2, "one notice per 6 h window, not one per cycle");
  assert.match(notices[0]!.text, /INCONNU/);
  assert.match(notices[0]!.text, /ne signifie PAS l'absence d'annonce/);
});

test("polite client: per-feed minimum interval, ETag/304, exponential back-off after errors", async () => {
  let t = 1_000_000;
  const calls: { url: string; h: Record<string, string> }[] = [];
  let mode: "ok" | "err" = "ok";
  const f: FeedFetcher = async (url, init) => {
    calls.push({ url, h: init.headers });
    if (mode === "err") return { status: 503, text: async () => "" };
    if (init.headers["If-None-Match"] === '"v1"') return { status: 304, text: async () => "" };
    return { status: 200, text: async () => '<rss><channel><title>x</title><item><title>Hello world today</title><link>https://e.test/1</link><pubDate>Wed, 14 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>', headers: { get: (n: string) => (n.toLowerCase() === "etag" ? '"v1"' : null) } };
  };
  const feed = { id: "f", url: "https://e.test/rss", class: "press" as const, kind: "rss" as const, minIntervalMs: 120_000 };
  const c = new PoliteFeedClient(f, () => t);
  assert.equal((await c.fetchDue([feed], 60_000)).statuses[0]!.state, "ok");
  t += 60_000;
  assert.equal((await c.fetchDue([feed], 60_000)).statuses[0]!.state, "not_due", "feed minimum interval (120 s) beats the 60 s poll");
  t += 61_000;
  const r = await c.fetchDue([feed], 60_000);
  assert.equal(r.statuses[0]!.state, "unchanged");
  assert.equal(calls.at(-1)!.h["If-None-Match"], '"v1"');
  assert.match(calls[0]!.h["User-Agent"]!, /read-only/);
  mode = "err";
  t += 130_000;
  const e1 = await c.fetchDue([feed], 60_000);
  assert.equal(e1.statuses[0]!.state, "error");
  t += 130_000;
  assert.equal((await c.fetchDue([feed], 60_000)).statuses[0]!.state, "backoff", "back-off grows beyond the normal interval");
});

test("sources: only free public feeds — no X, Truth Social, Nitter, scraping or paid service anywhere in the watcher", () => {
  for (const f of WATCH_FEEDS) assert.doesNotMatch(f.url, /(^|\/\/|\.)(x|twitter)\.com|truthsocial|nitter|xcancel|apify/i, f.id);
  const dir = new URL("../src/detective/breaking-signal/watch/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const src = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(src, /api\.x\.com|api\.twitter\.com|nitter|xcancel|apify|scoring\/|sendTransaction|signTransaction/i, file);
  }
});

test("simulation and watcher never use the network and never send real messages", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => (calls++, Promise.reject(new Error("no network")))) as typeof fetch;
  try {
    const h = simWatcher();
    await runSim(h);
    assert.equal(calls, 0);
    assert.equal(h.notifier.mode, "simulation");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("measured delays: publication, first detection, alert 1, enquiry and alert 2 are all recorded; simulated publication lag is labelled", async () => {
  const h = simWatcher();
  await runSim(h);
  const [probable, confirmed] = h.w.results;
  assert.ok(probable!.latency.publicationToDetectionMs! >= 30_000);
  assert.equal(probable!.latency.publicationToDetectionIsSimulated, true);
  assert.match(probable!.latency.note, /SIMULÉ/);
  assert.ok(probable!.latency.firstAlertMs! >= 60_000, "includes the wait for corroboration (honest)");
  assert.ok(confirmed!.latency.investigationMs !== null && confirmed!.latency.firstToSecondAlertMs !== null);
  assert.ok(confirmed!.times.notified1! <= confirmed!.times.detectiveStarted!);
  assert.ok(confirmed!.times.detectiveDone! <= confirmed!.times.notified2!);
});

test("CLI: `watch --simulate` runs offline end to end; the shell script is valid and `start` refuses nothing silently", () => {
  const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", "scripts/breaking-signal.ts", "watch", "--simulate"], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /SIMULATION \(horloge virtuelle, articles fictifs\)/);
  assert.match(out, /RÉFÉRENCE INITIALE \(aucune alerte\)/);
  assert.match(out, /ALERTE 2\/2/);
  assert.match(out, /\(simulé, non envoyé\)/);
  assert.doesNotMatch(out, /ENVOI RÉEL AUTORISÉ.*envoy/);
  execFileSync("bash", ["-n", "scripts/breaking-watch.sh"], { cwd: new URL("..", import.meta.url) });
});
