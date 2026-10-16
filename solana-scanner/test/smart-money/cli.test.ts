import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/smart-money/cli/main.ts";
import { loadConfig } from "../../src/smart-money/config.ts";
import { validateEvent } from "../../src/smart-money/contract/events.ts";
import { SmartMoneyStore } from "../../src/smart-money/store/store.ts";
import { addr, demoWalletTxs } from "../../src/smart-money/demo/fixtures.ts";
import { tmpDir } from "./helpers.ts";

async function cli(env: Record<string, string>, ...args: string[]) {
  const out: string[] = [];
  const code = await main(args, env, (s) => out.push(s));
  return { code, out: out.join("\n") };
}

test("init / run --once / events / status work end to end, offline", async () => {
  const dir = tmpDir();
  const env = { SMART_MONEY_DIR: dir };
  assert.equal((await cli(env, "init")).code, 0);
  assert.ok(existsSync(join(dir, "snapshots", "meta.json")));
  const run = await cli(env, "run", "--once");
  assert.equal(run.code, 0);
  assert.match(run.out, /hors-ligne simulé/);
  const ev = await cli(env, "events");
  const lines = ev.out.split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.data.state), ["started", "stopped"]);
  assert.ok(lines.every((e) => validateEvent(e).ok && e.simulated === true && e.notAdvice === true));
  assert.equal((await cli(env, "events", "--after", "1")).out.split("\n").length, 1);
  assert.match((await cli(env, "status")).out, /Événements : 2/);
});

test("--live is refused outside the guarded `wallet` command", async () => {
  const r = await cli({ SMART_MONEY_DIR: tmpDir() }, "run", "--live");
  assert.equal(r.code, 2);
  assert.match(r.out, /n'existe que pour la commande `wallet`/);
});

test("config exposes the provisional thresholds and honours overrides; bad values are rejected", async () => {
  const d = JSON.parse((await cli({ SMART_MONEY_DIR: tmpDir() }, "config")).out);
  assert.equal(d.thresholds.minClosedPositions, 20);
  assert.equal(d.thresholds.walkForwardDays, 14);
  assert.deepEqual(d.tipAccounts, []);
  assert.equal(loadConfig({ SMART_MONEY_MIN_CLOSED: "5", SMART_MONEY_WALKFORWARD_DAYS: "7" }).thresholds.minClosedPositions, 5);
  assert.throws(() => loadConfig({ SMART_MONEY_MIN_CLOSED: "-1" }), /positive/);
  assert.deepEqual(loadConfig({ SMART_MONEY_TIP_ACCOUNTS: "a, b" }).tipAccounts, ["a", "b"]);
});

test("demo runs on fictional data and writes a simulated event only to its own directory", async () => {
  const dir = tmpDir();
  const r = await cli({ SMART_MONEY_DIR: tmpDir() }, "demo", "--dir", dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /DONNÉES ENTIÈREMENT FICTIVES/);
  assert.match(r.out, /INCONNU/);
  assert.ok(existsSync(join(dir, "outbox", "events.jsonl")));
});

test("analyze reads saved HistoryTx, prints the profile and can emit the event (idempotently)", async () => {
  const dir = tmpDir();
  const file = join(dir, "txs.json");
  const w = addr(11);
  writeFileSync(file, JSON.stringify({ txs: demoWalletTxs(w) }));
  const env = { SMART_MONEY_DIR: join(dir, "mem") };
  const r = await cli(env, "analyze", file, "--wallet", w, "--complete", "--emit");
  assert.equal(r.code, 0);
  assert.match(r.out, /historique COMPLET/);
  assert.match(r.out, /Événement écrit : seq 1/);
  assert.match((await cli(env, "analyze", file, "--wallet", w, "--complete", "--emit")).out, /déjà présent/);
  assert.equal((await cli(env, "analyze")).code, 2);
});

test("a real process stops cleanly on SIGTERM and records its 'stopped' event", async () => {
  const { spawn } = await import("node:child_process");
  const dir = tmpDir();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/smart-money.ts", "run", "--interval", "1"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, SMART_MONEY_DIR: dir },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  try {
    // Started = its "started" event is in the outbox (no dependence on console text or timing).
    const deadline = Date.now() + 20_000;
    const started = () => new SmartMoneyStore(dir).readEvents().events.some((e) => (e.data as { state?: string }).state === "started");
    while (!started()) {
      if (Date.now() > deadline) throw new Error("the agent did not start");
      await new Promise((r) => setTimeout(r, 50));
    }
    // Give the run loop a moment to install its signal handlers after writing "started".
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    assert.equal(code, 0);
    const states = new SmartMoneyStore(dir).readEvents().events.map((e) => (e.data as { state: string }).state);
    assert.deepEqual(states, ["started", "stopped"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
