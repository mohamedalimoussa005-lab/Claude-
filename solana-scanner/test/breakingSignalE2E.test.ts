/**
 * Phase 0 validation: one fictitious Trump announcement goes through the whole pipeline, offline, with Telegram in
 * simulation and no paid call. Simulated publication delays are never presented as real X detection delays.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, SIM_ACCOUNT, createNotifier, handleEvent, telegramFromEnv, xStatus } from "../src/detective/breaking-signal/index.ts";
import type { PipelineDeps } from "../src/detective/breaking-signal/index.ts";
import { TRUMP_MINT } from "../src/detective/breaking-signal/sources.ts";
import type { DetectiveBrief, OnchainQuick, PostEvent } from "../src/detective/breaking-signal/types.ts";
import type { SimulatedNotifier } from "../src/detective/breaking-signal/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mint = (m: string, state: OnchainQuick["state"] = "valid_mint"): OnchainQuick => ({ mint: m, state, program: "Tokenkeg", supply: "1", decimals: 6, mintAuthority: null, freezeAuthority: null, pools: [], reason: null });

function harness(over: { check?: (m: string) => Promise<OnchainQuick | null>; investigate?: (m: string) => Promise<DetectiveBrief> } = {}) {
  const log: { at: number; what: string }[] = [];
  const mark = (what: string) => log.push({ at: Date.now(), what });
  const networkCalls: string[] = [];
  // Telegram variables are NOT set: the notifier must stay in simulation and never touch the network.
  const notifier = createNotifier(telegramFromEnv({}), async (u) => (networkCalls.push(u), { status: 500, json: async () => ({}) })) as SimulatedNotifier;
  const send = notifier.send.bind(notifier);
  notifier.send = async (t) => (mark(`message:${t.includes("ALERTE 2/2") ? 2 : 1}`), send(t));
  const deps: PipelineDeps = {
    cfg: { ...DEFAULT_CONFIG, accounts: [SIM_ACCOUNT] },
    notifier,
    checkMint: async (m) => (mark("check-onchain"), sleep(20).then(() => (over.check ? over.check(m) : mint(m)))),
    detective: async (m) => {
      mark("detective-start");
      await sleep(120);
      const b = over.investigate ? await over.investigate(m) : ({ mint: m, mode: "rapide", calls: 12, elapsedMs: 120, limitsReached: ["plafond de 3 page(s) de signatures atteint"], status: "done", reason: null, findings: [{ level: "FAIT", text: "Aucune autorité de mint active." }, { level: "INCONNU", text: "Lancement non atteint: premiers acheteurs inconnus." }] } as DetectiveBrief);
      mark("detective-end");
      return b;
    },
  };
  return { deps, log, notifier, networkCalls };
}

const announcement = (over: Partial<PostEvent> = {}): PostEvent => ({ id: "990000000000001", authorId: SIM_ACCOUNT.userId, handle: SIM_ACCOUNT.handle, text: `FICTIF: My new Official Trump Meme is HERE! Contract: ${TRUMP_MINT}`, createdAt: Date.now() - 3000, url: "https://x.com/realDonaldTrump/status/990000000000001", kind: "original", provenance: "simulation", ...over });

test("E2E phase 0: fictitious Trump announcement → detection → alert 1 → enquiry (valid address) → alert 2, latencies measured separately, no paid call", async () => {
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (u: unknown) => (hosts.push(String(u)), Promise.reject(new Error("aucun appel réseau attendu dans ce test")))) as typeof fetch;
  try {
    const h = harness();
    const injectedAt = Date.now();
    const r = await handleEvent(announcement(), h.deps);

    // 1. injected   2. detected and timestamped
    assert.equal(r.event.provenance, "simulation");
    assert.ok(r.times.received >= injectedAt);
    assert.ok(r.times.published < r.times.received);
    assert.ok(r.times.extracted !== undefined && r.times.verified !== undefined);
    assert.equal(r.verification.level, "CONFIRMÉ");

    // 3. first notification generated in simulation, before the enquiry starts, without waiting for it
    assert.equal(h.notifier.mode, "simulation");
    const order = h.log.map((x) => x.what);
    assert.deepEqual(order, ["check-onchain", "message:1", "detective-start", "detective-end", "message:2"]);
    assert.ok(r.times.notified1! <= r.times.detectiveStarted!, "alert 1 timestamp precedes the enquiry start (the event order above is the strict proof)");
    assert.match(h.notifier.outbox[0]!.text, /\[SIMULATION — événement fictif\] ALERTE 1\/2 — CONFIRMÉ/);
    assert.match(h.notifier.outbox[0]!.text, /Lien original: https:\/\/x\.com\/realDonaldTrump\/status\/990000000000001/);
    assert.match(h.notifier.outbox[0]!.text, /Publié: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z · détecté: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

    // 4. enquiry started because a valid Solana address was available
    assert.equal(r.verification.officialAddress, TRUMP_MINT);
    assert.equal(r.detective?.mint, TRUMP_MINT);

    // 5. second notification carries the results AND the limits
    assert.equal(h.notifier.outbox.length, 2);
    assert.match(h.notifier.outbox[1]!.text, /ALERTE 2\/2/);
    assert.match(h.notifier.outbox[1]!.text, /\[FAIT\] Aucune autorité de mint active/);
    assert.match(h.notifier.outbox[1]!.text, /limites: plafond de 3 page\(s\) de signatures atteint/);
    assert.match(h.notifier.outbox[1]!.text, /\[INCONNU\] Lancement non atteint/);

    // 6. detection, first alert and enquiry latencies are measured separately
    const l = r.latency;
    assert.ok(l.publicationToDetectionMs !== null && l.publicationToDetectionMs >= 3000);
    assert.equal(l.publicationToDetectionIsSimulated, true);
    assert.ok(l.detectionProcessingMs !== null && l.detectionProcessingMs >= 0 && l.detectionProcessingMs < 1000);
    assert.ok(l.firstAlertMs !== null && l.firstAlertMs >= 15 && l.firstAlertMs < 1000, `first alert ${l.firstAlertMs}`);
    assert.ok(l.investigationMs !== null && l.investigationMs >= 100, `enquiry ${l.investigationMs}`);
    assert.ok(l.firstToSecondAlertMs! >= l.investigationMs!);
    assert.ok(l.firstAlertMs < l.investigationMs, "first alert is faster than the enquiry");
    assert.match(l.note, /SIMULÉ.*pas un délai réel de détection sur X/);
    assert.match(h.notifier.outbox[0]!.text, /écart SIMULÉ: pas un délai réel sur X/);

    // 7. no network, hence no paid call; Telegram untouched; X not connected
    assert.deepEqual(hosts, []);
    assert.deepEqual(h.networkCalls, []);
    assert.equal(xStatus({}).monitoring, false);
    assert.equal(r.event.provenance === ("x-official" as string), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("E2E: the enquiry starts ONLY when a valid Solana address exists (none, malformed, or not a mint → no enquiry)", async () => {
  const cases: { text: string; check?: (m: string) => Promise<OnchainQuick | null>; why: string }[] = [
    { text: "FICTIF: Big Trump announcement soon, stay tuned", why: "no address" },
    { text: "FICTIF: Contract 6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSq0i2jfGiPN", why: "malformed address (invalid base58 character)" },
    { text: `FICTIF: Contract ${TRUMP_MINT}`, check: async (m) => mint(m, "not_a_mint"), why: "valid format but not a mint" },
    { text: `FICTIF: Contract ${TRUMP_MINT}`, check: async (m) => mint(m, "not_found"), why: "valid format but absent on-chain" },
  ];
  for (const c of cases) {
    const h = harness({ check: c.check });
    const r = await handleEvent(announcement({ id: `${Math.random()}`, text: c.text }), h.deps);
    assert.equal(r.detective, null, c.why);
    assert.ok(!h.log.some((x) => x.what === "detective-start"), c.why);
    assert.equal(h.notifier.outbox.length, 1, `${c.why}: only the first notification`);
    assert.doesNotMatch(h.notifier.outbox[0]!.text, /Enquête DETECTIVE en cours/, c.why);
    assert.match(h.notifier.outbox[0]!.text, /Aucune enquête lancée/, c.why);
    assert.equal(r.latency.investigationMs, null);
  }
});

test("E2E: a failing or limited enquiry still produces the second notification with the reason", async () => {
  const h = harness({ investigate: async () => { throw new Error("RPC public saturé"); } });
  const r = await handleEvent(announcement({ id: "fail-1" }), h.deps);
  assert.equal(h.notifier.outbox.length, 2);
  assert.match(h.notifier.outbox[1]!.text, /Enquête ÉCHOUÉE: RPC public saturé/);
  assert.equal(r.detective?.status, "failed");
});

test("E2E CLI: `breaking simulate trump-launch` runs offline, in simulation, and labels simulated delays", () => {
  const env = { ...process.env, BREAKING_SIGNAL_TELEGRAM_TOKEN: "", BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "", BREAKING_SIGNAL_TELEGRAM_SEND: "" };
  const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", "scripts/breaking-signal.ts", "simulate", "trump-launch", "--out", "/tmp/claude-0/bs-e2e-test"], { cwd: new URL("..", import.meta.url), encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /ALERTE 1\/2 — CONFIRMÉ/);
  assert.match(out, /ALERTE 2\/2/);
  assert.match(out, /\(simulé, non envoyé\)/);
  assert.match(out, /Latences \(mesurées séparément\)/);
  assert.match(out, /SIMULÉ, pas un délai réel sur X/);
  assert.match(out, /première alerte — réception → message 1/);
  assert.match(out, /enquête — durée DETECTIVE/);
  assert.doesNotMatch(out, /ENVOI RÉEL|\(envoyé\)/);
});
