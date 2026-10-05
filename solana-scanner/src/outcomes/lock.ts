/**
 * Single-writer lock for the outcome dataset: an exclusive lock file next to it
 * (created with O_EXCL, holding pid + time). Every read-modify-write of
 * observations.json runs under it, so a capture and an update never overwrite
 * each other. A lock whose process is gone, or older than `staleMs`, is taken
 * over. Released in `finally` and on SIGINT / SIGTERM.
 */

import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface LockOptions {
  /** Give up after this long waiting for another writer. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. */
  staleMs?: number;
  pollMs?: number;
}

const held = new Set<string>();
let signalsInstalled = false;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const lockPathOf = (dir: string) => join(dir, "observations.lock");

function tryAcquire(path: string, staleMs: number): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // Existing lock: take it over only when abandoned (dead process or too old).
  let info: { pid?: number; at?: number } = {};
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    info = {};
  }
  const abandoned = (typeof info.pid === "number" && info.pid !== process.pid && !alive(info.pid)) || typeof info.at !== "number" || Date.now() - info.at > staleMs;
  if (!abandoned) return false;
  rmSync(path, { force: true });
  return tryAcquire(path, Number.POSITIVE_INFINITY);
}

function release(path: string) {
  if (!held.has(path)) return;
  held.delete(path);
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (info.pid === process.pid) rmSync(path, { force: true });
  } catch {
    // already gone
  }
}

function installSignalRelease() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      for (const p of [...held]) release(p);
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/** Runs `fn` while holding the dataset lock of `dir`; waits for another writer, never runs concurrently with it. */
export async function withLock<T>(dir: string, fn: () => Promise<T> | T, o: LockOptions = {}): Promise<T> {
  const { timeoutMs = 120_000, staleMs = 15 * 60_000, pollMs = 200 } = o;
  mkdirSync(dir, { recursive: true });
  const path = lockPathOf(dir);
  installSignalRelease();
  const start = Date.now();
  while (!tryAcquire(path, staleMs)) {
    if (Date.now() - start > timeoutMs) throw new Error(`dataset locked by another writer (${path})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  held.add(path);
  try {
    return await fn();
  } finally {
    release(path);
  }
}
