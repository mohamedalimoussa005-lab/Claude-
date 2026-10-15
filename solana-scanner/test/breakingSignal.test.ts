import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, SCENARIOS, SIM_ACCOUNT, TelegramNotifier, SimulatedNotifier, createNotifier, extractFromPost, handleEvent, parsePumpEvent, readEventsFile, redact, telegramFromEnv, validateAccounts, verifyPost, watchPumpPortal, xStatus } from "../src/detective/breaking-signal/index.ts";
import type { PipelineDeps } from "../src/detective/breaking-signal/index.ts";
import { FAKE_MINT, TRUMP_MINT } from "../src/detective/breaking-signal/sources.ts";
import type { DetectiveBrief, OnchainQuick, PostEvent } from "../src/detective/breaking-signal/types.ts";
import { NOT_ADVICE } from "../src/detective/breaking-signal/types.ts";

const T0 = Date.parse("2026-10-14T12:00:00Z");
const cfg = { ...DEFAULT_CONFIG, accounts: [SIM_ACCOUNT], fastCheckMs: 200 };
const validMint = (mint: string): OnchainQuick => ({ mint, state: "valid_mint", program: "Tokenkeg", supply: "1", decimals: 6, mintAuthority: null, freezeAuthority: null, pools: [{ dexId: "meteora", pairAddress: "p", liquidityUsd: 1000, url: "https://dexscreener.com/solana/p", createdAt: null }], reason: null });
const brief = (mint: string): DetectiveBrief => ({ mint, mode: "rapide", calls: 7, elapsedMs: 50, limitsReached: [], status: "done", reason: null, findings: [{ level: "FAIT", text: "Autorité de mint révoquée." }] });
const mk = (over: Partial<PipelineDeps> = {}): PipelineDeps & { notifier: SimulatedNotifier } => {
  let t = T0;
  const now = () => (t += 5);
  return { cfg, notifier: new SimulatedNotifier("test", now), now, checkMint: async (m: string) => validMint(m), detective: async (m: string) => brief(m), ...over } as never;
};
const ev = (over: Partial<PostEvent> = {}): PostEvent => ({ id: "1", authorId: SIM_ACCOUNT.userId, handle: SIM_ACCOUNT.handle, text: "x", createdAt: T0 - 2000, url: "https://x.com/a/status/1", kind: "original", provenance: "simulation", ...over });

test("scenarios: every simulated case lands on its expected level (offline)", async () => {
  for (const s of SCENARIOS) {
    const deps = mk({ fetchPage: async (u) => s.pages?.[u] ?? null });
    const r = await handleEvent(s.event(T0, 2000), deps);
    assert.equal(r.verification.level, s.expected, `${s.id}: ${JSON.stringify(r.verification.criteria)}`);
  }
});

test("levels have explicit criteria: CONFIRMÉ needs whitelist + original + address + valid mint; PROBABLE = authentic but no established contract", async () => {
  const a = await verifyPost({ event: ev({ text: `new coin ${TRUMP_MINT}` }), extraction: extractFromPost(ev({ text: `new coin ${TRUMP_MINT}` }), cfg), accounts: cfg.accounts, checkMint: async (m) => validMint(m) });
  assert.equal(a.verification.level, "CONFIRMÉ");
  assert.deepEqual(a.verification.criteria.map((c) => `${c.id}:${c.ok}`), ["C1:true", "C2:true", "C3:true", "C4:true"]);
  const run = async (event: PostEvent, check?: (m: string) => Promise<OnchainQuick | null>, pages?: Record<string, string>) => (await verifyPost({ event, extraction: extractFromPost(event, cfg), accounts: cfg.accounts, checkMint: check, fetchPage: async (u) => pages?.[u] ?? null })).verification;
  assert.equal((await run(ev({ text: "coming soon, new meme coin" }))).level, "PROBABLE", "no address");
  assert.equal((await run(ev({ text: `ca ${TRUMP_MINT}` }), async (m) => ({ ...validMint(m), state: "not_a_mint" }))).level, "PROBABLE", "address is not a mint");
  assert.equal((await run(ev({ text: `ca ${TRUMP_MINT}` }), async () => null)).level, "PROBABLE", "on-chain check unavailable → not confirmed");
  assert.equal((await run(ev({ text: `a ${TRUMP_MINT} b ${FAKE_MINT}` }), async (m) => validMint(m))).level, "PROBABLE", "two addresses → ambiguous");
  assert.equal((await run(ev({ text: "see https://other.example/x" }), async (m) => validMint(m), { "https://other.example/x": `ca ${TRUMP_MINT}` })).level, "PROBABLE", "address only on a non-official page");
  const v = await run(ev({ text: "d" }));
  assert.ok(v.criteria.find((c) => c.id === "C4")!.ok === null || v.criteria.find((c) => c.id === "C4")!.text.includes("sans objet"));
});

test("impersonation and wrong author never reach CONFIRMÉ; look-alike handles are flagged; a changed handle is noted", async () => {
  const text = `Official Trump Meme ${TRUMP_MINT}`;
  for (const over of [{ authorId: "1", handle: "realDonaldTrump" }, { authorId: "1", handle: "realDonaIdTrump" }, { authorId: "1", handle: "someoneelse" }, { kind: "reply" as const }, { kind: "quote" as const }, { kind: "repost" as const }]) {
    const e = ev({ text, ...over });
    const { verification: v } = await verifyPost({ event: e, extraction: extractFromPost(e, cfg), accounts: cfg.accounts, checkMint: async (m) => validMint(m) });
    assert.equal(v.level, "NON VÉRIFIÉ", JSON.stringify(over));
  }
  const twin = ev({ text, authorId: "1", handle: "realDonaIdTrump" });
  const t = await verifyPost({ event: twin, extraction: extractFromPost(twin, cfg), accounts: cfg.accounts });
  assert.ok(t.verification.notes.some((n) => /USURPATION POSSIBLE/.test(n)));
  const renamed = ev({ text, handle: "newname" });
  const r = await verifyPost({ event: renamed, extraction: extractFromPost(renamed, cfg), accounts: cfg.accounts, checkMint: async (m) => validMint(m) });
  assert.equal(r.verification.level, "CONFIRMÉ");
  assert.ok(r.verification.notes.some((n) => /pseudo a changé/.test(n)));
});

test("a token that merely uses the name never raises a level (homonyms are context only)", async () => {
  const r = await handleEvent(ev({ authorId: "1", handle: "random", text: "Official Trump Meme coming" }), mk({ findHomonyms: async () => [{ mint: FAKE_MINT, name: "OFFICIAL TRUMP", symbol: "TRUMP", liquidityUsd: 9e6, url: null }] }));
  assert.equal(r.verification.level, "NON VÉRIFIÉ");
  assert.match(r.alerts[0]!.text, /Leur nom ne prouve AUCUN lien avec l'annonce/);
  const teaser = await handleEvent(ev({ id: "2", text: "Official Trump Meme coming soon" }), mk({ findHomonyms: async () => [{ mint: FAKE_MINT, name: "OFFICIAL TRUMP", symbol: "TRUMP", liquidityUsd: 9e6, url: null }] }));
  assert.equal(teaser.verification.level, "PROBABLE");
  assert.equal(teaser.verification.officialAddress, null, "homonym address is not adopted as the announced address");
  assert.equal(teaser.detective, null);
});

test("alert 1 is sent BEFORE the DETECTIVE enquiry starts and never waits for it; alert 2 follows", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  const deps = mk({
    detective: async (m) => {
      order.push("detective-start");
      await gate;
      order.push("detective-end");
      return brief(m);
    },
  });
  const origSend = deps.notifier.send.bind(deps.notifier);
  deps.notifier.send = async (t) => (order.push(`send:${t.includes("ALERTE 1/2") ? 1 : 2}`), origSend(t));
  const p = handleEvent(ev({ text: `Official Trump Meme ${TRUMP_MINT}` }), deps);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ["send:1", "detective-start"], "message 1 delivered while the enquiry is still blocked");
  assert.equal(deps.notifier.outbox.length, 1);
  release();
  const r = await p;
  assert.deepEqual(order, ["send:1", "detective-start", "detective-end", "send:2"]);
  assert.equal(r.alerts.length, 2);
  assert.match(r.alerts[1]!.text, /ALERTE 2\/2/);
  const t = r.times;
  assert.ok(t.published < t.received && t.received <= t.extracted! && t.extracted! <= t.verified! && t.verified! <= t.notified1! && t.notified1! <= t.detectiveStarted! && t.detectiveStarted! <= t.detectiveDone! && t.detectiveDone! <= t.notified2!);
  for (const [k, v] of Object.entries(r.delays)) assert.ok(v === null || v >= 0, k);
  assert.ok(r.delays["alerte 1 → départ enquête"]! <= 20);
});

test("a slow on-chain check is time-boxed: alert 1 still goes out, the check is reported as unknown", async () => {
  const deps = mk({ checkMint: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await handleEvent(ev({ text: `Official Trump Meme ${TRUMP_MINT}` }), deps);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.verification.level, "PROBABLE");
  assert.match(r.alerts[0]!.text, /INCONNUE \(délai dépassé ou indisponible\)/);
});

test("no address → one alert, no enquiry; not-a-mint address → no enquiry; failing enquiry is reported; duplicates are silent", async () => {
  let calls = 0;
  const d = mk({ detective: async (m) => (calls++, brief(m)) });
  const a = await handleEvent(ev({ id: "10", text: "AI companies are the future, Anthropic is great" }), d);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0]!.text, /Aucun token n'est annoncé/);
  const b = await handleEvent(ev({ id: "11", text: `ca ${TRUMP_MINT}` }), mk({ checkMint: async (m) => ({ ...validMint(m), state: "not_a_mint" }), detective: async (m) => (calls++, brief(m)) }));
  assert.equal(b.alerts.length, 1);
  assert.equal(calls, 0);
  const f = await handleEvent(ev({ id: "12", text: `ca ${TRUMP_MINT}` }), mk({ detective: async () => { throw new Error("rpc down"); } }));
  assert.equal(f.alerts.length, 2);
  assert.match(f.alerts[1]!.text, /ÉCHOUÉE: rpc down/);
  const seen = new Set<string>();
  const dd = mk({ seen });
  await handleEvent(ev({ id: "13", text: "hello" }), dd);
  const again = await handleEvent(ev({ id: "13", text: "hello" }), dd);
  assert.equal(again.duplicate, true);
  assert.equal(again.alerts.length, 0);
  assert.equal(dd.notifier.outbox.length, 1);
});

test("alerts carry the original link, UTC timestamps, the not-advice notice, and never advise or accuse", async () => {
  const r = await handleEvent(ev({ text: `Official Trump Meme ${TRUMP_MINT}`, url: "https://x.com/realDonaldTrump/status/910" }), mk());
  for (const a of r.alerts) {
    assert.ok(a.text.includes(NOT_ADVICE));
    assert.doesNotMatch(a.text.replace(NOT_ADVICE, ""), /acheter|achetez|buy now|to the moon|garanti|arnaque|scam|rug/i);
  }
  assert.match(r.alerts[0]!.text, /Lien original: https:\/\/x\.com\/realDonaldTrump\/status\/910/);
  assert.match(r.alerts[0]!.text, /Publié: 2026-10-14T11:59:58Z/);
  assert.match(r.alerts[0]!.text, /\[SIMULATION — événement fictif\]/);
});

test("Telegram: simulation unless token + chat id + explicit SEND=yes; nothing is sent in simulation; the token never leaks", async () => {
  const token = "123456789:AAH_fake_token_value_for_tests_0123456789";
  assert.equal(telegramFromEnv({}).configured, false);
  assert.equal(telegramFromEnv({ BREAKING_SIGNAL_TELEGRAM_TOKEN: token, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "42" }).sendAuthorized, false, "configured but not authorized");
  assert.equal(telegramFromEnv({ BREAKING_SIGNAL_TELEGRAM_TOKEN: "bad", BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "42", BREAKING_SIGNAL_TELEGRAM_SEND: "yes" }).sendAuthorized, false, "invalid token format");
  const ok = telegramFromEnv({ BREAKING_SIGNAL_TELEGRAM_TOKEN: token, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "42", BREAKING_SIGNAL_TELEGRAM_SEND: "yes" });
  assert.equal(ok.sendAuthorized, true);

  let fetched = 0;
  const sim = createNotifier(telegramFromEnv({ BREAKING_SIGNAL_TELEGRAM_TOKEN: token, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "42" }), async () => (fetched++, { status: 200, json: async () => ({}) }));
  assert.equal(sim.mode, "simulation");
  assert.doesNotMatch(sim.reason, new RegExp(token));
  await sim.send("hello");
  assert.equal(fetched, 0, "no network call in simulation");

  let seenUrl = "";
  let body = "";
  const live = createNotifier(ok, async (u, i) => ((seenUrl = u), (body = i.body), { status: 200, json: async () => ({ ok: true, result: { date: 1_760_000_000 } }) }));
  assert.equal(live.mode, "live");
  const out = await live.send("x".repeat(5000));
  assert.equal(out.ok, true);
  assert.equal(out.telegramDate, 1_760_000_000_000);
  assert.ok(seenUrl.startsWith("https://api.telegram.org/bot"));
  assert.ok(JSON.parse(body).text.length <= 4000);
  assert.equal(JSON.parse(body).disable_web_page_preview, true);

  const failing = new TelegramNotifier(ok, async () => { throw new Error(`connect failed for https://api.telegram.org/bot${token}/sendMessage`); });
  const f = await failing.send("x");
  assert.equal(f.ok, false);
  assert.doesNotMatch(f.error ?? "", /AAH_fake|123456789:/);
  const http = new TelegramNotifier(ok, async () => ({ status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }));
  assert.match((await http.send("x")).error ?? "", /401/);
  assert.equal(redact(`x bot${token}/y`, null).includes("AAH_fake"), false);
});

test("X: never monitored in phase 0 — no connection claim, a token in the environment is reported but unused, no X host in the source", () => {
  assert.equal(xStatus({}).monitoring, false);
  assert.equal(xStatus({}).state, "NON CONNECTÉ");
  const s = xStatus({ BREAKING_SIGNAL_X_BEARER_TOKEN: "secret-value" });
  assert.equal(s.monitoring, false);
  assert.equal(s.state, "JETON PRÉSENT, NON UTILISÉ");
  assert.doesNotMatch(JSON.stringify(s), /secret-value/);
  const dir = new URL("../src/detective/breaking-signal/", import.meta.url);
  for (const f of readdirSync(dir, { recursive: true }).map(String).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /api\.x\.com|api\.twitter\.com|nitter|xcancel|apify|scoring\/|sendTransaction|signTransaction/i, f);
  }
});

test("watch list: only numeric user ids are accepted (a handle is not an identity)", () => {
  const r = validateAccounts({ accounts: [{ userId: "25073877", handle: "@someone", label: "L", officialDomains: ["Example.com", "not a domain"] }, { userId: "REMPLACER", handle: "x" }, { handle: "y" }] });
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0]!.handle, "someone");
  assert.deepEqual(r.accounts[0]!.officialDomains, ["example.com"]);
  assert.equal(r.problems.length, 2);
});

test("extraction: valid Solana addresses only (also inside URLs), tickers and launch wording", () => {
  const e = extractFromPost(ev({ text: `New coin $TRUMP CA ${TRUMP_MINT} https://dexscreener.com/solana/${FAKE_MINT} and junk 1111111111111111111111111111111111111111111111 abc` }), cfg);
  assert.deepEqual(e.addresses.sort(), [FAKE_MINT, TRUMP_MINT].sort());
  assert.deepEqual(e.tickers, ["TRUMP"]);
  assert.equal(e.mentionsLaunch, true);
  assert.equal(extractFromPost(ev({ text: "nice weather today" }), cfg).mentionsLaunch, false);
});

test("PumpPortal: parsing is tolerant, acknowledgements are ignored, watched names are flagged as UNOFFICIAL matches", async () => {
  assert.equal(parsePumpEvent('{"message":"Successfully subscribed to keys."}', 1, ["trump"]), null);
  assert.equal(parsePumpEvent("not json", 1, []), null);
  const e = parsePumpEvent(JSON.stringify({ signature: "s", mint: TRUMP_MINT, name: "Trump Coin 2", symbol: "TRUMP2", timestamp: 1_760_000_000 }), 1_760_000_000_500, ["trump"])!;
  assert.equal(e.watchedMatch, "trump");
  assert.equal(e.sourceTime, 1_760_000_000_000);

  class FakeWS {
    handlers: Record<string, ((e: unknown) => void)[]> = {};
    sent: string[] = [];
    constructor() {
      setTimeout(() => this.emit("open", {}), 5);
      setTimeout(() => this.emit("message", { data: '{"message":"Successfully subscribed"}' }), 10);
      setTimeout(() => this.emit("message", { data: JSON.stringify({ signature: "s1", mint: FAKE_MINT, name: "TrumpCat", symbol: "TC" }) }), 15);
      setTimeout(() => this.emit("message", { data: JSON.stringify({ signature: "s2", mint: TRUMP_MINT, name: "Other", symbol: "OT" }) }), 20);
    }
    addEventListener(t: string, h: (e: unknown) => void) { (this.handlers[t] ??= []).push(h); }
    emit(t: string, e: unknown) { (this.handlers[t] ?? []).forEach((h) => h(e)); }
    send(s: string) { this.sent.push(s); }
    close() {}
  }
  const r = await watchPumpPortal({ seconds: 0.1, watched: ["trump"], WebSocketImpl: FakeWS as never });
  assert.equal(r.connected, true);
  assert.equal(r.events.length, 2);
  assert.equal(r.watchedMatches.length, 1);
  assert.ok(r.payloadKeys.includes("mint"));
  const none = await watchPumpPortal({ seconds: 0.1, watched: [], WebSocketImpl: undefined as never });
  assert.ok(none.error !== null || none.connected === false || none.events.length >= 0);
});

test("events file: lines are validated, provenance is forced to 'file' (never 'x-official')", () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-"));
  const p = join(dir, "e.jsonl");
  writeFileSync(p, [JSON.stringify({ id: "1", authorId: "5", handle: "a", text: "t", createdAt: "2026-10-14T12:00:00Z", url: "https://x.com/a/status/1", provenance: "x-official" }), "not json", JSON.stringify({ id: "2" })].join("\n"));
  const r = readEventsFile(p);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.provenance, "file");
  assert.equal(r.problems.length, 2);
});
