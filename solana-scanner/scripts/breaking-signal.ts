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
import { SCENARIOS, SIM_ACCOUNT, checkMintQuick, createNotifier, findHomonyms, handleEvent, loadConfig, readEventsFile, scenarioById, telegramFromEnv, watchPumpPortal, xStatus } from "../src/detective/breaking-signal/index.ts";
import type { PipelineDeps } from "../src/detective/breaking-signal/index.ts";
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
  console.log("usage: npm run breaking -- status | simulate [scenario|all] [--live-checks] [--detective-calls N] [--age-sec N] | file EVENTS.jsonl | pumpportal [--seconds N]  (--config FILE --out DIR)");
  process.exit(0);
}

const { config: loaded, problems } = loadConfig(val("config"));
const tg = telegramFromEnv(process.env);
const notifier = createNotifier(tg, (u, i) => globalThis.fetch(u, i) as never);

if (cmd === "status") {
  const x = xStatus(process.env);
  console.log(`X: ${x.state} — ${x.message}`);
  console.log(`Telegram: ${notifier.mode === "live" ? "ENVOI RÉEL AUTORISÉ" : "SIMULATION"} — ${notifier.reason}`);
  console.log(`Liste blanche: ${loaded.accounts.length} compte(s) chargé(s)${problems.length ? ` · ${problems.join(" ; ")}` : ""}`);
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

const live = flag("live-checks");
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
