import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { assessToken } from "../src/final/assessment.ts";
import { lockPathOf, withLock } from "../src/outcomes/lock.ts";
import { formatStatus } from "../src/outcomes/status.ts";
import { addObservations, backupStore, datasetBytes, fileOf, loadStore, replaceOutcomes, saveStore } from "../src/outcomes/store.ts";
import { applyFetch, buildObservation, CHECKPOINTS } from "../src/outcomes/tracker.ts";
import type { CheckpointKey, Observation } from "../src/outcomes/tracker.ts";
import { scorePair } from "../src/scoring/score.ts";

/** Offline: collection infrastructure (lock, backup, status, restart). */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const tmp = () => mkdtempSync(join(tmpdir(), "outcomes-ops-"));
const pair = (o: Partial<NormalizedPair> = {}): NormalizedPair => ({
  chainId: "solana", dexId: "pumpswap", url: null, pairAddress: "PAIR_A", tokenAddress: "MINT_1", tokenName: "Fixture", tokenSymbol: "FIX", quoteSymbol: "SOL",
  priceUsd: 0.001, marketCap: 400_000, fdv: 400_000, liquidityUsd: 60_000, volumeM5: 9_000, volumeH1: 70_000, volumeH6: 200_000, volumeH24: 400_000,
  buysM5: 40, sellsM5: 20, buysH1: 500, sellsH1: 300, priceChangeM5: 4, priceChangeH1: 30, priceChangeH6: 60, pairCreatedAt: T0 - 4 * 60 * MIN, ...o,
});
const observe = (p: NormalizedPair = pair(), t0 = T0): Observation => {
  const score = scorePair(p, t0);
  return buildObservation({ pair: p, score, assessment: assessToken({ score }), capturedAt: t0, candidate: false, onchain: null, step3Status: "NOT_RUN", wallets: null, step4Status: "NOT_RUN" });
};
const at = (key: CheckpointKey, extraMin = 0, t0 = T0) => t0 + CHECKPOINTS.find((c) => c.key === key)!.ms + extraMin * MIN;
const ok = (price: number, pairAddress = "PAIR_A") => ({ status: "OK" as const, pair: pair({ priceUsd: price, pairAddress }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_MODULE = fileURLToPath(new URL("../src/outcomes/lock.ts", import.meta.url));

/** Child process that takes the lock, prints LOCKED and holds it for `holdMs` (or forever). */
function lockHolder(dir: string, holdMs: number | null) {
  const f = join(dir, "holder.ts");
  writeFileSync(f, `import { withLock } from ${JSON.stringify(LOCK_MODULE)};\nawait withLock(${JSON.stringify(dir)}, async () => { console.log("LOCKED"); await new Promise((r) => ${holdMs === null ? "setInterval(() => {}, 1000)" : `setTimeout(r, ${holdMs})`}); });\n`);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", f], { stdio: ["ignore", "pipe", "inherit"] });
  const locked = new Promise<void>((resolve) => child.stdout!.on("data", (b) => String(b).includes("LOCKED") && resolve()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, locked, exited };
}

test("A: two writers never write at the same time (same process and across processes)", async () => {
  const dir = tmp();
  try {
    const events: string[] = [];
    const writer = (name: string) => withLock(dir, async () => {
      events.push(`${name}:start`);
      await sleep(80);
      events.push(`${name}:end`);
    }, { pollMs: 10 });
    await Promise.all([writer("a"), writer("b")]);
    assert.deepEqual(events.map((e) => e.split(":")[1]), ["start", "end", "start", "end"], "serialised, no overlap");

    const h = lockHolder(dir, 600);
    await h.locked;
    await assert.rejects(withLock(dir, () => "never", { timeoutMs: 150, pollMs: 20 }), /locked by another writer/);
    assert.equal(await withLock(dir, () => "after", { timeoutMs: 10_000, pollMs: 20 }), "after", "acquired once the other process released it");
    assert.equal(await h.exited, 0);
    assert.ok(!existsSync(lockPathOf(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B: an abandoned lock (dead process, or too old) is taken over", async () => {
  const dir = tmp();
  try {
    writeFileSync(lockPathOf(dir), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    assert.equal(await withLock(dir, () => "dead-pid", { timeoutMs: 1000 }), "dead-pid");
    writeFileSync(lockPathOf(dir), JSON.stringify({ pid: process.ppid, at: Date.now() - 60 * MIN }));
    assert.equal(await withLock(dir, () => "stale", { timeoutMs: 1000, staleMs: 15 * MIN }), "stale");
    writeFileSync(lockPathOf(dir), "garbage");
    assert.equal(await withLock(dir, () => "unreadable", { timeoutMs: 1000 }), "unreadable");
    assert.ok(!existsSync(lockPathOf(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C / D: backup is byte-identical to the dataset and leaves the source untouched", () => {
  const dir = tmp();
  try {
    assert.equal(backupStore(dir), null, "no dataset: nothing to copy");
    saveStore(addObservations(loadStore(dir), [observe(), observe(pair({ pairAddress: "PAIR_B" }))]).store, dir);
    const src = readFileSync(fileOf(dir));
    const mtime = statSync(fileOf(dir)).mtimeMs;
    const dest = backupStore(dir, new Date(Date.UTC(2026, 9, 5, 8, 9, 10)))!;
    assert.ok(dest.endsWith(join("backups", "observations-20261005-080910.json")));
    assert.deepEqual(readFileSync(dest), src);
    assert.deepEqual(readFileSync(fileOf(dir)), src);
    assert.equal(statSync(fileOf(dir)).mtimeMs, mtime);
    const second = backupStore(dir, new Date(Date.UTC(2026, 9, 5, 8, 9, 10)))!;
    assert.notEqual(second, dest, "same second: a new file, never an overwrite");
    assert.equal(readdirSync(join(dir, "backups")).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const clean = (t: string) => assert.ok(!/NaN|Infinity|undefined|\[object Object\]/.test(t), t);

test("E: status on an empty dataset", () => {
  const t = formatStatus([], T0, null, "/x/observations.json");
  clean(t);
  for (const s of ["TOTAL OBSERVATIONS: 0", "NEW LAST 24H: 0", "MOMENTUM: 0", "5m: 0/0", "MISSED: 0", "PROVIDER ERRORS: 0", "OLDEST INCOMPLETE OBSERVATION: aucune", "DATASET SIZE: absent"]) assert.ok(t.includes(s), s);
});

test("F / G: status on a partial dataset counts OK, MISSED and provider errors", () => {
  let a = observe();
  a = applyFetch(a, at("5m", 1), ok(0.0012));
  a = applyFetch(a, at("15m", 1), { status: "PROVIDER_ERROR", error: "HTTP 429" });
  let b = observe(pair({ pairAddress: "PAIR_B" }), T0 + 10 * MIN);
  b = applyFetch(b, at("1h", 1, T0 + 10 * MIN), { status: "UNAVAILABLE" }); // 5m / 15m / 30m windows passed → MISSED
  const now = at("1h", 2, T0 + 10 * MIN);
  const t = formatStatus([a, b], now, 2048, "/x/observations.json");
  clean(t);
  assert.ok(t.includes("TOTAL OBSERVATIONS: 2"));
  assert.ok(t.includes("NEW LAST 24H: 2"));
  assert.ok(t.includes("5m: 1/2 · MISSED 1"));
  assert.ok(t.includes("15m: 0/2 · MISSED 1 · PROVIDER_ERROR 1"));
  assert.ok(t.includes("MISSED: 3"));
  assert.ok(t.includes("PROVIDER ERRORS: 1"));
  assert.ok(t.includes("UNAVAILABLE: 1"));
  assert.ok(t.includes(`T0 ${new Date(T0).toISOString()}`), "oldest incomplete = the first observation");
  assert.ok(t.includes("DATASET SIZE: 2.0 Ko"));
});

test("H / I: restart neither duplicates observations nor rewrites an OK checkpoint", async () => {
  const dir = tmp();
  try {
    const capture = (obs: Observation[]) => withLock(dir, () => saveStore(addObservations(loadStore(dir), obs).store, dir));
    const update = (now: number, price: number) =>
      withLock(dir, () => {
        const s = loadStore(dir);
        saveStore(replaceOutcomes(s, s.observations.map((o) => applyFetch(o, now, ok(price, o.snapshot.identity.pairAddress)))), dir);
      });
    await capture([observe()]);
    await update(at("5m", 1), 0.0015);
    const okBefore = loadStore(dir).observations[0].outcomes["5m"];
    const snapBefore = JSON.stringify(loadStore(dir).observations[0].snapshot);
    // "Restart": the same capture again, then updates resuming later.
    await capture([observe()]);
    await update(at("5m", 6), 0.009);
    await update(at("15m", 1), 0.002);
    const s = loadStore(dir);
    assert.equal(s.observations.length, 1);
    assert.deepEqual(s.observations[0].outcomes["5m"], okBefore, "OK checkpoint unchanged");
    assert.equal(s.observations[0].outcomes["15m"]!.returnPct, 100, "resumed with the next due checkpoint");
    assert.equal(JSON.stringify(s.observations[0].snapshot), snapBefore);
    assert.ok(datasetBytes(dir)! > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("J: Ctrl+C (SIGINT) on a process holding the lock releases it", async () => {
  const dir = tmp();
  try {
    const h = lockHolder(dir, null);
    await h.locked;
    assert.ok(existsSync(lockPathOf(dir)));
    h.child.kill("SIGINT");
    assert.equal(await h.exited, 130);
    assert.ok(!existsSync(lockPathOf(dir)), "lock file removed");
    assert.equal(await withLock(dir, () => "free", { timeoutMs: 500 }), "free");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
