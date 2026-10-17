/**
 * SMART MONEY TRACKER command line (phases 0-2, offline only).
 *
 *   smart-money init                      create the memory directory
 *   smart-money status                    memory + process state
 *   smart-money config                    thresholds in force
 *   smart-money run [--once] [--interval SEC]   idle simulated loop: heartbeat only, no network
 *   smart-money events [--after SEQ] [--limit N]   read the outbox (as a consumer would)
 *   smart-money demo [--dir DIR]          pipeline on FICTIONAL data
 *   smart-money wallet ADDR… (--demo | --offline FILE | --dry-run | --live …)   see cli/wallet.ts
 *   smart-money estimate [--wallets N --max-tx N …]   cost estimate, sends nothing
 *   smart-money diagnose [--wallet ADDR] [--json] [--out FILE]   offline, read-only diagnostic of collected data
 *   smart-money preflight                  offline checklist before any live trial
 *   smart-money analyze FILE --wallet ADDR [--complete] [--emit]   PnL from saved HistoryTx JSON (array or {txs})
 *
 * Only `wallet --live` can reach the network, behind a guard (explicit budget, 3 wallets max). No Telegram, no trading.
 */

import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { createEvent } from "../contract/events.ts";
import { runDemo } from "../demo/run.ts";
import { profileEvent } from "../pnl/events.ts";
import { formatProfile } from "../pnl/format.ts";
import { analyzeWallet } from "../pnl/profile.ts";
import { SmartMoneyStore } from "../store/store.ts";
import { diagnoseCommand } from "./diagnose.ts";
import { estimateCommand, preflightCommand, walletCommand } from "./wallet.ts";
import type { WalletDeps } from "./wallet.ts";
import type { HistoryTx } from "../../history/types.ts";

const flag = (a: string[], name: string) => a.includes(name);
const opt = (a: string[], name: string): string | undefined => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, log: (s: string) => void = console.log, deps: WalletDeps = {}): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  if (flag(argv, "--live") && cmd !== "wallet") {
    log("--live n'existe que pour la commande `wallet` (derrière sa garde : budget explicite, 3 wallets maximum).");
    return 2;
  }
  const config = loadConfig(env);
  const store = new SmartMoneyStore(config.dir);

  switch (cmd) {
    case "init": {
      await store.writeSnapshot("meta", { createdBy: "smart-money init", criteriaVersion: config.criteriaVersion });
      log(`Mémoire prête : ${config.dir}`);
      return 0;
    }
    case "status": {
      const s = store.status();
      const pidFile = ".smart-money.pid";
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
      log(`Mémoire : ${s.dir}\nÉvénements : ${s.events} (dernier seq ${s.lastSeq}, lignes corrompues ${s.corruptLines})\nSnapshots : ${s.snapshots.join(", ") || "aucun"}`);
      log(`Processus : ${pid && alive(pid) ? `en cours (pid ${pid})` : "à l'arrêt"}`);
      const hb = store.readSnapshot<{ at: number; mode: string }>("heartbeat");
      if (hb) log(`Dernier battement : ${new Date(hb.data.at).toISOString()} (mode ${hb.data.mode})`);
      return 0;
    }
    case "config": {
      log(JSON.stringify(config, null, 2));
      return 0;
    }
    case "run": {
      const once = flag(rest, "--once");
      const interval = Math.max(1, Number(opt(rest, "--interval") ?? 60));
      const beat = async (state: string) => {
        const now = Date.now();
        await store.writeSnapshot("heartbeat", { at: now, mode: "simulated-offline", state });
        return now;
      };
      const emit = async (state: string, now: number) =>
        store.appendEvents([createEvent({ kind: "agent.heartbeat", dedupKey: `${state}@${now}`, evidenceTier: "VERIFIED", criteriaVersion: config.criteriaVersion, simulated: true, data: { state, mode: "simulated-offline" }, now })]);
      await emit("started", await beat("started"));
      log("SMART MONEY TRACKER démarré (mode hors-ligne simulé : aucun appel réseau, aucune notification).");
      if (once) {
        await emit("stopped", await beat("stopped"));
        return 0;
      }
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => void beat("running"), interval * 1000);
        const stop = () => {
          clearInterval(timer);
          resolve();
        };
        // The shared lock helper installs a SIGTERM/SIGINT handler that exits at once; here we are idle (no lock held),
        // so we replace it to be able to write the final "stopped" event before leaving.
        for (const sig of ["SIGTERM", "SIGINT"] as const) {
          process.removeAllListeners(sig);
          process.once(sig, stop);
        }
      });
      await emit("stopped", await beat("stopped"));
      log("Arrêté proprement.");
      return 0;
    }
    case "events": {
      const { events, corruptLines, skipped } = store.readEvents({ afterSeq: Number(opt(rest, "--after") ?? 0), limit: opt(rest, "--limit") ? Number(opt(rest, "--limit")) : undefined });
      for (const e of events) log(JSON.stringify(e));
      if (corruptLines || skipped) log(`(ignorées : ${corruptLines} lignes illisibles, ${skipped} événements invalides)`);
      return 0;
    }
    case "wallet":
      return walletCommand(rest, { config, store, env, log, deps });
    case "estimate":
      return estimateCommand(rest, { config, store, env, log, deps });
    case "diagnose":
      return diagnoseCommand(rest, { config, env, log, now: deps.now });
    case "preflight":
      return preflightCommand(rest, { config, store, env, log, deps });
    case "demo": {
      await runDemo(log, { dir: opt(rest, "--dir") });
      return 0;
    }
    case "analyze": {
      const file = rest.find((a) => !a.startsWith("--") && a !== opt(rest, "--wallet"));
      const wallet = opt(rest, "--wallet");
      if (!file || !wallet) {
        log("usage : smart-money analyze FILE --wallet ADDR [--complete] [--emit]");
        return 2;
      }
      const raw = JSON.parse(readFileSync(file, "utf8")) as HistoryTx[] | { txs: HistoryTx[] };
      const txs = Array.isArray(raw) ? raw : raw.txs;
      const { pnl, profile } = analyzeWallet(wallet, txs, { coverage: { complete: flag(rest, "--complete"), oldestTime: null }, config });
      log(formatProfile(profile));
      if (flag(rest, "--emit")) {
        const [r] = await store.appendEvents([profileEvent(profile, pnl, { now: Date.now(), criteriaVersion: config.criteriaVersion, simulated: false })]);
        log(`Événement ${r.duplicate ? "déjà présent" : "écrit"} : seq ${r.event.seq}`);
      }
      return 0;
    }
    default:
      log("commandes : init · status · config · run · events · demo · analyze (voir src/smart-money/cli/main.ts)");
      return cmd === "help" ? 0 : 2;
  }
}

