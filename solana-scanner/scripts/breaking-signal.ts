/**
 * DETECTIVE Breaking Signal — phase 0 (free, read-only, no X call).
 *
 *   npm run breaking -- status
 *   npm run breaking -- simulate [scenario|all] [--live-checks] [--detective-calls N] [--age-sec N] [--config FILE] [--out DIR]
 *   npm run breaking -- file EVENTS.jsonl [--live-checks] [--config FILE]
 *   npm run breaking -- pumpportal [--seconds N]
 *
 * Telegram: BREAKING_SIGNAL_TELEGRAM_TOKEN + BREAKING_SIGNAL_TELEGRAM_CHAT_ID + BREAKING_SIGNAL_TELEGRAM_SEND=yes (all three,
 * from the environment only). Anything less → simulated outbox, nothing is sent. X is NEVER queried in phase 0.
 * --live-checks reads the public Solana RPC and DEX Screener (free). Behind a proxy start Node with NODE_USE_ENV_PROXY=1.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DexScreenerClient } from "../src/api/dexscreener.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { SolanaRpc } from "../src/onchain/rpc.ts";
import { newMeter, runDetective } from "../src/detective/run.ts";
import { withMode } from "../src/detective/modes.ts";
import type { ReadRpc } from "../src/detective/meter.ts";
import { ENV_FILE, SCENARIOS, SIM_ACCOUNT, checkMintQuick, createNotifier, findHomonyms, handleEvent, loadConfig, loadEnvFile, readEventsFile, scenarioById, telegramFromEnv, watchPumpPortal, xStatus } from "../src/detective/breaking-signal/index.ts";
import type { PipelineDeps } from "../src/detective/breaking-signal/index.ts";
import { DEFAULT_WATCH, SIM_TICKS, StateStore, Watcher, createSimulation } from "../src/detective/breaking-signal/watch/index.ts";
import { SimulatedNotifier } from "../src/detective/breaking-signal/index.ts";
import type { Notifier } from "../src/detective/breaking-signal/index.ts";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import type { BreakingResult, DetectiveBrief, OnchainQuick, PostEvent } from "../src/detective/breaking-signal/types.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (n: string, d: number) => {
  const v = val(n);
  if (v === undefined) return d;
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) throw new Error(`--${n} doit être un nombre positif`);
  return x;
};
const fmt = (ms: number | null) => (ms === null ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

if (cmd === "help" || flag("help")) {
  console.log("usage: npm run breaking -- status | watch [--simulate] [--interval 60] [--send] [--once] | simulate [scenario|all] [--live-checks] [--detective-calls N] [--age-sec N] | file EVENTS.jsonl | pumpportal [--seconds N]  (--config FILE --out DIR)");
  process.exit(0);
}

const envLoaded = loadEnvFile(ENV_FILE, process.env); // .env.breaking (git-ignored); never overrides variables already set
const { config: loaded, problems } = loadConfig(val("config"));
const tg = telegramFromEnv(process.env);
const notifier = createNotifier(tg, (u, i) => globalThis.fetch(u, i) as never);

if (cmd === "status") {
  const x = xStatus(process.env);
  console.log(`X: ${x.state} — ${x.message}`);
  console.log(`Telegram: ${notifier.mode === "live" ? "ENVOI RÉEL AUTORISÉ" : "SIMULATION"} — ${notifier.reason}`);
  console.log(`Liste blanche: ${loaded.accounts.length} compte(s) chargé(s)${problems.length ? ` · ${problems.join(" ; ")}` : ""}`);
  if (envLoaded.length) console.log(`Variables chargées depuis ${ENV_FILE}: ${envLoaded.join(", ")} (valeurs masquées)`);
  console.log("Coût: 0 $ (aucun appel payant). Trading: aucun.");
  process.exit(0);
}

if (cmd === "pumpportal") {
  const seconds = num("seconds", 20);
  console.error(`PumpPortal subscribeNewToken (gratuit, sans clé) pendant ${seconds} s…`);
  const r = await watchPumpPortal({ seconds, watched: loaded.watchedNames });
  const lags = r.events.filter((e) => e.sourceTime !== null).map((e) => e.receivedAt - e.sourceTime!);
  console.log(JSON.stringify({ connecté: r.connected, délaiConnexionMs: r.connectMs, premierÉvénementMs: r.firstEventMs, événements: r.events.length, parMinute: seconds ? Math.round((r.events.length / seconds) * 60) : null, champsDuMessage: r.payloadKeys, correspondancesNomsSurveillés: r.watchedMatches.map((e) => ({ nom: e.name, symbole: e.symbol, mint: e.mint })), écartMoyenSourceMs: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null, erreur: r.error }, null, 2));
  process.exit(0);
}

// the real watcher always uses real read-only checks (a fixture must never vouch for a mint); only --simulate may use fixtures
const live = flag("live-checks") || (cmd === "watch" && !flag("simulate"));
const dex = new DexScreenerClient();
const detectiveCalls = num("detective-calls", 100);
const cfg = { ...loaded, accounts: [...(cmd === "simulate" ? [SIM_ACCOUNT] : []), ...loaded.accounts] };

let rpcMeterCalls = 0;
const rpc = live ? (new SolanaRpc({ config: ONCHAIN_CONFIG }) as unknown as ReadRpc) : null;
const fixtureQuick = (mint: string): OnchainQuick => ({ mint, state: "valid_mint", program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", supply: "(fixture)", decimals: 6, mintAuthority: null, freezeAuthority: null, pools: [], reason: "données de test (fixture), pas une lecture réelle" });
const deps: PipelineDeps = {
  cfg,
  notifier,
  checkMint: live ? async (m) => (rpcMeterCalls++, checkMintQuick({ rpc: rpc!, dex }, m)) : async (m) => fixtureQuick(m),
  fetchPage: async (u) => {
    for (const s of SCENARIOS) if (s.pages?.[u]) return s.pages[u]!;
    return null;
  },
  findHomonyms: live ? (names, ex) => findHomonyms(dex, names, ex) : undefined,
  detective: live
    ? async (mint): Promise<DetectiveBrief> => {
        const mode = withMode("rapide", { maxCalls: detectiveCalls });
        const meter = newMeter(mode);
        const r = await runDetective({ mint, mode: "rapide", overrides: { maxCalls: mode.maxCalls } }, { dex, rpc: new SolanaRpc({ config: ONCHAIN_CONFIG, onRequest: meter.onRequest }) as unknown as ReadRpc, meter });
        return { mint, mode: "rapide", calls: r.report.budget.calls, elapsedMs: r.report.budget.elapsedMs, limitsReached: r.report.budget.limitsReached, status: "done", reason: null, findings: r.report.sections.synthesis.findings.slice(0, 8) };
      }
    : async (mint) => ({ mint, mode: "rapide", calls: 0, elapsedMs: 0, limitsReached: [], status: "skipped", reason: "enquête non exécutée hors --live-checks", findings: [] }),
};


if (cmd === "watch") {
  const simulate = flag("simulate");
  const intervalMs = Math.max(30, num("interval", 60)) * 1000;
  const statePath = simulate && !val("state") ? null : (val("state") ?? ".breaking-state.json");
  const eventsPath = simulate ? null : (val("events") ?? ".breaking-events.jsonl");
  const stamp = () => new Date(simClock ? simClock() : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  let simClock: (() => number) | null = null;
  const log = (l: string) => console.log(`[${stamp()}] ${l}`);
  // real Telegram only with --send AND BREAKING_SIGNAL_TELEGRAM_SEND=yes; a simulation never sends
  const real = !simulate && flag("send") && notifier.mode === "live";
  if (flag("send") && !real) log(simulate ? "--send ignoré: une simulation n'envoie jamais de message" : `--send demandé mais envoi non autorisé: ${notifier.reason}`);
  const sim = simulate ? createSimulation() : null;
  simClock = sim ? sim.now : null;
  const base: Notifier = real ? notifier : new SimulatedNotifier("simulation", sim ? sim.now : Date.now);
  const show: Notifier = real ? base : { mode: "simulation", reason: base.reason, send: async (t) => { console.log(`\n--- message (simulé, non envoyé) ---\n${t}\n---`); return base.send(t); } };
  const lock = ".breaking-watch.lock";
  if (!simulate) {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) { console.error(`une surveillance tourne déjà (pid ${pid}); arrêtez-la d'abord (npm run watch:stop)`); process.exit(1); }
    }
    writeFileSync(lock, String(process.pid));
    const rm = () => { try { unlinkSync(lock); } catch { /* already gone */ } };
    process.on("exit", rm);
  }
  const store = new StateStore(statePath, sim ? sim.now : Date.now);
  const eventLog = eventsPath ? (e: Record<string, unknown>) => appendFileSync(eventsPath, JSON.stringify(e) + "\n") : undefined;
  const watcher = new Watcher({ ...DEFAULT_WATCH, intervalMs, baseline: !flag("no-baseline"), fastCheckMs: simulate ? 500 : loaded.fastCheckMs }, {
    fetch: sim ? sim.fetch : (((u: string, i: unknown) => globalThis.fetch(u, i as RequestInit)) as never),
    notifier: show,
    store,
    now: sim ? sim.now : Date.now,
    provenance: simulate ? "simulation" : "rss",
    checkMint: deps.checkMint,
    findHomonyms: deps.findHomonyms,
    detective: simulate && !live ? async (mint): Promise<DetectiveBrief> => (await new Promise((r) => setTimeout(r, 150)), { mint, mode: "rapide", calls: 0, elapsedMs: 150, limitsReached: ["données de test (fixture): aucune lecture réelle"], status: "done", reason: null, findings: [{ level: "INCONNU", text: "Enquête simulée sur fixture: aucun résultat réel." }] }) : deps.detective,
    log,
    eventLog,
  });
  console.log(`Breaking Signal · watch · ${simulate ? "SIMULATION (horloge virtuelle, articles fictifs)" : `flux gratuits réels toutes les ${intervalMs / 1000} s minimum (chaque flux garde son propre intervalle)`}`);
  console.log(`X: ${xStatus(process.env).state} (aucun compte X surveillé) · Telegram: ${real ? "ENVOI RÉEL AUTORISÉ" : "SIMULATION"} · enquête: ${live ? "lectures réelles" : "fixtures"} · coût 0 $`);
  if (simulate) {
    for (let i = 0; i < SIM_TICKS; i++) {
      const r = await watcher.tick();
      console.log(`cycle ${i}: ${r.fetched} article(s), ${r.newArticles} nouveau(x), ${r.relevantNew} pertinent(s)${r.baseline ? " — RÉFÉRENCE INITIALE (aucune alerte)" : ""}, ${r.alerts.length} alerte(s)${r.ignored.length ? `, ignoré(s): ${r.ignored.map((x) => `« ${x.title.slice(0, 50)} » (${x.reason})`).join("; ")}` : ""}`);
      await watcher.drain();
      sim!.advance();
    }
    console.log("\nDélais mesurés (simulation; publication → détection SIMULÉ, étapes internes RÉELLES):");
    for (const r of watcher.results) console.log(`  ${r.signal.kind === "new" ? "alerte" : "mise à jour"} ${r.signal.verification.level}: publication→détection ${fmt(r.latency.publicationToDetectionMs)} (simulé) · détection→alerte 1 ${fmt(r.latency.firstAlertMs)} · enquête ${fmt(r.latency.investigationMs)} · alerte1→alerte2 ${fmt(r.latency.firstToSecondAlertMs)}`);
    process.exit(0);
  }
  const ac = new AbortController();
  for (const sg of ["SIGINT", "SIGTERM"] as const) process.on(sg, () => { log(`${sg} reçu: arrêt après la fin de l'enquête en cours`); ac.abort(); });
  if (flag("once")) {
    const r = await watcher.tick();
    await watcher.drain();
    console.log(JSON.stringify({ sources: r.statuses.map((s) => ({ id: s.id, état: s.state, articles: s.items, raison: s.reason })), nouveaux: r.newArticles, pertinents: r.relevantNew, alertes: r.alerts.length, ignorés: r.ignored.length, aveugle: r.blind, référenceInitiale: r.baseline }, null, 2));
    process.exit(0);
  }
  log(`surveillance démarrée (état: ${statePath}); Ctrl-C ou npm run watch:stop pour arrêter`);
  await watcher.run(ac.signal);
  log("surveillance arrêtée proprement");
  process.exit(0);
}

let events: PostEvent[] = [];
const ageMs = num("age-sec", 2) * 1000;
if (cmd === "simulate") {
  const id = args[1] && !args[1].startsWith("--") ? args[1] : "trump-launch";
  const list = id === "all" ? SCENARIOS : [scenarioById(id)].filter((s): s is NonNullable<typeof s> => !!s);
  if (list.length === 0) throw new Error(`scénario inconnu "${id}" (${SCENARIOS.map((s) => s.id).join(", ")}, all)`);
  const now = Date.now();
  events = list.map((s) => s.event(now, ageMs));
} else if (cmd === "file") {
  if (!args[1]) throw new Error("usage: breaking -- file EVENTS.jsonl");
  const r = readEventsFile(args[1]);
  events = r.events;
  for (const p of r.problems) console.error(`fichier: ${p}`);
} else throw new Error(`commande inconnue "${cmd}"`);

console.error(`Breaking Signal · phase 0 · X ${xStatus(process.env).state} · Telegram ${notifier.mode === "live" ? "RÉEL" : "SIMULATION"} · ${live ? "lectures gratuites réelles" : "fixtures hors réseau"} · coût 0 $`);
const seen = new Set<string>();
const results: BreakingResult[] = [];
for (const e of events) results.push(await handleEvent(e, { ...deps, seen }));

const dir = join(val("out") ?? "detective-reports", `breaking-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "results.json"), JSON.stringify({ x: xStatus(process.env), telegram: { mode: notifier.mode, reason: notifier.reason }, rpcChecks: rpcMeterCalls, results }, null, 2));
for (const r of results) {
  console.log(`\n=== ${r.event.id} — ${r.verification.level} ===`);
  for (const a of r.alerts) console.log(`\n--- Message ${a.stage}/${r.alerts.length > 1 ? 2 : 1} ${notifier.mode === "live" ? "(envoyé)" : "(simulé, non envoyé)"} ---\n${a.text}`);
  console.log("\nLatences (mesurées séparément):");
  const l = r.latency;
  console.log(`  détection — publication → réception: ${fmt(l.publicationToDetectionMs)}${l.publicationToDetectionIsSimulated ? " (SIMULÉ, pas un délai réel sur X)" : ""}; traitement interne: ${fmt(l.detectionProcessingMs)}`);
  console.log(`  première alerte — réception → message 1: ${fmt(l.firstAlertMs)}`);
  console.log(`  enquête — durée DETECTIVE: ${fmt(l.investigationMs)}; message 1 → message 2: ${fmt(l.firstToSecondAlertMs)}`);
  console.log("\nDélais par étape:");
  for (const [k, v] of Object.entries(r.delays)) if (v !== null) console.log(`  ${k}: ${fmt(v)}${k.startsWith("publication") && l.publicationToDetectionIsSimulated ? " (simulé)" : ""}`);
}
console.error(`\nRésultats écrits dans ${dir}/results.json`);
