/**
 * Data collection runner: orchestrates the existing outcome commands only (no scoring here).
 *
 *   npm run outcomes:collect                 UPDATE every 5 min, CAPTURE (--wallets) every 30 min, until Ctrl+C
 *   npm run outcomes:collect -- --no-wallets CAPTURE without Step 4
 *   npm run outcomes:collect -- --once       one CAPTURE then one UPDATE, then exit
 *
 * Two independent schedules, so a long capture (Step 3 / 4 take minutes) never delays the
 * 5-minute updates that the short checkpoints need. Never two captures or two updates at
 * once; writes to the dataset are serialised by its lock. A failed run is logged and the
 * schedule continues; on restart, `update` simply resumes the checkpoints that are due.
 * Ctrl+C: no new run starts, running ones get SIGINT (they release the lock) and are awaited.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPDATE_EVERY_MS = 5 * 60_000;
const CAPTURE_EVERY_MS = 30 * 60_000;

const args = process.argv.slice(2);
const once = args.includes("--once");
const wallets = !args.includes("--no-wallets");
const script = join(dirname(fileURLToPath(import.meta.url)), "outcomes.ts");
const running = new Map<string, ChildProcess>();
let stopping = false;

const log = (tag: string, msg: string) => console.log(`[${tag}] ${new Date().toISOString()} ${msg}`);

function run(kind: "capture" | "update"): Promise<void> {
  if (stopping) return Promise.resolve();
  if (running.has(kind)) {
    log("RUNNER", `${kind} précédent encore en cours : ce tour est sauté`);
    return Promise.resolve();
  }
  const extra = kind === "capture" && wallets ? ["--wallets"] : [];
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, kind, ...extra], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  running.set(kind, child);
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      running.delete(kind);
      if (code !== 0) log("RUNNER", `${kind} terminé avec ${signal ?? `code ${code}`} : la collecte continue`);
      resolve();
    });
    child.on("error", (e) => {
      running.delete(kind);
      log("RUNNER", `${kind} impossible à lancer : ${e.message}`);
      resolve();
    });
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  log("RUNNER", `arrêt demandé : ${running.size} opération(s) en cours`);
  for (const c of running.values()) c.kill("SIGINT");
  await Promise.all([...running.values()].map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : c.on("exit", r)))));
  log("RUNNER", "arrêté proprement");
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

log("RUNNER", `démarrage · UPDATE toutes les ${UPDATE_EVERY_MS / 60_000} min · CAPTURE toutes les ${CAPTURE_EVERY_MS / 60_000} min${wallets ? " (--wallets)" : ""}${once ? " · une seule fois" : ""}`);
// Resume first: checkpoints already due (e.g. after a restart) before anything else.
await run("update");
if (once) {
  await run("capture");
  await run("update");
} else {
  const captureThenUpdate = () => run("capture").then(() => run("update"));
  void captureThenUpdate();
  setInterval(() => void run("update"), UPDATE_EVERY_MS);
  setInterval(() => void captureThenUpdate(), CAPTURE_EVERY_MS);
}
