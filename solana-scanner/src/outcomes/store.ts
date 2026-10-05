/**
 * Local persistence of observations: one JSON file, written atomically
 * (temp file + rename). Runtime data lives under data/outcomes/ (git-ignored);
 * OUTCOMES_DIR overrides the directory (tests use a temporary one).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashSnapshot, SCHEMA_VERSION } from "./tracker.ts";
import type { Observation } from "./tracker.ts";

export interface OutcomeStore {
  schemaVersion: number;
  observations: Observation[];
}

export const defaultOutcomesDir = () => process.env.OUTCOMES_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../data/outcomes");
export const fileOf = (dir: string) => join(dir, "observations.json");

export function loadStore(dir: string = defaultOutcomesDir()): OutcomeStore {
  const f = fileOf(dir);
  if (!existsSync(f)) return { schemaVersion: SCHEMA_VERSION, observations: [] };
  const s = JSON.parse(readFileSync(f, "utf8")) as OutcomeStore;
  for (const o of s.observations) if (hashSnapshot(o.snapshot) !== o.snapshotHash) throw new Error(`snapshot ${o.snapshot.observationId} does not match its capture hash`);
  return s;
}

export function saveStore(store: OutcomeStore, dir: string = defaultOutcomesDir()): void {
  mkdirSync(dir, { recursive: true });
  const f = fileOf(dir);
  writeFileSync(`${f}.tmp`, JSON.stringify(store, null, 1));
  renameSync(`${f}.tmp`, f);
}

/** Adds observations whose id is not stored yet; an existing snapshot is never replaced. */
export function addObservations(store: OutcomeStore, obs: Observation[]): { store: OutcomeStore; added: number; skipped: number } {
  const ids = new Set(store.observations.map((o) => o.snapshot.observationId));
  const fresh = obs.filter((o) => !ids.has(o.snapshot.observationId) && (ids.add(o.snapshot.observationId), true));
  return { store: { ...store, observations: [...store.observations, ...fresh] }, added: fresh.length, skipped: obs.length - fresh.length };
}

/**
 * Replaces observations by id with updated ones (outcomes only): refuses any snapshot change.
 */
export function replaceOutcomes(store: OutcomeStore, updated: Observation[]): OutcomeStore {
  const byId = new Map(updated.map((o) => [o.snapshot.observationId, o]));
  return {
    ...store,
    observations: store.observations.map((o) => {
      const u = byId.get(o.snapshot.observationId);
      if (!u) return o;
      if (u.snapshotHash !== o.snapshotHash || hashSnapshot(u.snapshot) !== o.snapshotHash) throw new Error(`snapshot ${o.snapshot.observationId} changed: refused`);
      return { snapshot: o.snapshot, snapshotHash: o.snapshotHash, outcomes: u.outcomes };
    }),
  };
}

export const datasetBytes = (dir: string = defaultOutcomesDir()): number | null => (existsSync(fileOf(dir)) ? statSync(fileOf(dir)).size : null);

/** Copies the dataset to backups/observations-YYYYMMDD-HHMMSS.json; the source is only read. */
export function backupStore(dir: string = defaultOutcomesDir(), now: Date = new Date()): string | null {
  const src = fileOf(dir);
  if (!existsSync(src)) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  mkdirSync(join(dir, "backups"), { recursive: true });
  let dest = join(dir, "backups", `observations-${stamp}.json`);
  for (let i = 1; existsSync(dest); i++) dest = join(dir, "backups", `observations-${stamp}-${i}.json`);
  copyFileSync(src, dest);
  return dest;
}
