/**
 * Server-side persistence of the history cache: one JSON file written
 * atomically (temp file + rename). It holds normalized transactions and
 * pagination state only — never a key, URL or environment value.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryHistoryCache } from "../src/history/cache.ts";
import type { HistoryCacheSnapshot } from "../src/history/cache.ts";

export interface SnapshotStore {
  load(): MemoryHistoryCache;
  save(cache: MemoryHistoryCache): void;
}

export class FileSnapshotStore implements SnapshotStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  load(): MemoryHistoryCache {
    if (!existsSync(this.path)) return new MemoryHistoryCache();
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8")) as HistoryCacheSnapshot;
      if (!Array.isArray(s.txs) || !Array.isArray(s.states) || typeof s.wallets !== "object") return new MemoryHistoryCache();
      return MemoryHistoryCache.fromSnapshot(s);
    } catch {
      // A corrupt snapshot is dropped, never half-loaded.
      return new MemoryHistoryCache();
    }
  }

  save(cache: MemoryHistoryCache): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache.snapshot()), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
