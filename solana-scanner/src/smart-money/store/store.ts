/**
 * Persistent memory of the agent, in its own directory:
 *   outbox/events.jsonl      append-only events (the contract's transport)
 *   snapshots/<name>.json    latest state of something (atomic replace)
 *   observations.lock        single-writer lock (shared outcomes lock helper)
 * Every write runs under the lock so two processes never interleave.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../../outcomes/lock.ts";
import { SCHEMA_VERSION, SOURCE } from "../contract/types.ts";
import type { EventEnvelope, NewEvent } from "../contract/types.ts";
import { validateEvent } from "../contract/events.ts";
import { atomicWriteJson } from "./atomic.ts";
import { appendJsonl, readJsonl } from "./jsonl.ts";

export const SNAPSHOT_SCHEMA = "smart-money.snapshot/1" as const;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SnapshotFile<T = unknown> {
  schema: typeof SNAPSHOT_SCHEMA;
  name: string;
  writtenAt: number;
  data: T;
}

export interface AppendResult {
  event: EventEnvelope;
  duplicate: boolean;
}

export interface StoreStatus {
  dir: string;
  events: number;
  lastSeq: number;
  corruptLines: number;
  snapshots: string[];
}

export class SmartMoneyStore {
  readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  get outboxPath(): string {
    return join(this.dir, "outbox", "events.jsonl");
  }

  private snapshotPath(name: string): string {
    if (!NAME.test(name)) throw new Error(`invalid snapshot name: ${name}`);
    return join(this.dir, "snapshots", `${name}.json`);
  }

  /** Appends events; one whose eventId is already stored is skipped (idempotent producers). */
  async appendEvents(events: NewEvent[]): Promise<AppendResult[]> {
    return withLock(this.dir, () => {
      const { records } = readJsonl<EventEnvelope>(this.outboxPath);
      const byId = new Map(records.map((r) => [r.eventId, r]));
      let seq = records.reduce((m, r) => Math.max(m, r.seq), 0);
      const out: AppendResult[] = [];
      const fresh: EventEnvelope[] = [];
      for (const e of events) {
        const known = byId.get(e.eventId);
        if (known) {
          out.push({ event: known, duplicate: true });
          continue;
        }
        const env: EventEnvelope = { schemaVersion: SCHEMA_VERSION, ...e, seq: ++seq, source: SOURCE, notAdvice: true };
        const v = validateEvent(env);
        if (!v.ok) throw new Error(`refusing to store an invalid event: ${v.errors.join(", ")}`);
        byId.set(env.eventId, env);
        fresh.push(env);
        out.push({ event: env, duplicate: false });
      }
      appendJsonl(this.outboxPath, fresh);
      return out;
    });
  }

  /** Valid events after `afterSeq` (a consumer's cursor), oldest first. Invalid lines are skipped. */
  readEvents(o: { afterSeq?: number; limit?: number } = {}): { events: EventEnvelope[]; corruptLines: number; skipped: number } {
    const { records, corruptLines } = readJsonl<unknown>(this.outboxPath);
    const events: EventEnvelope[] = [];
    let skipped = 0;
    for (const r of records) {
      const v = validateEvent(r);
      if (!v.ok) {
        skipped++;
        continue;
      }
      if (v.event.seq > (o.afterSeq ?? 0)) events.push(v.event);
    }
    events.sort((a, b) => a.seq - b.seq);
    return { events: o.limit ? events.slice(0, o.limit) : events, corruptLines, skipped };
  }

  async writeSnapshot<T>(name: string, data: T): Promise<SnapshotFile<T>> {
    const path = this.snapshotPath(name);
    const file: SnapshotFile<T> = { schema: SNAPSHOT_SCHEMA, name, writtenAt: this.now(), data };
    await withLock(this.dir, () => atomicWriteJson(path, file));
    return file;
  }

  /** null when absent or unreadable / from another schema (never throws on a corrupt file). */
  readSnapshot<T = unknown>(name: string): SnapshotFile<T> | null {
    const path = this.snapshotPath(name);
    if (!existsSync(path)) return null;
    try {
      const f = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile<T>;
      return f && f.schema === SNAPSHOT_SCHEMA && f.name === name ? f : null;
    } catch {
      return null;
    }
  }

  status(): StoreStatus {
    const { records, corruptLines } = readJsonl<{ seq?: number }>(this.outboxPath);
    const snapDir = join(this.dir, "snapshots");
    const snapshots = existsSync(snapDir) ? readdirSync(snapDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
    return { dir: this.dir, events: records.length, lastSeq: records.reduce((m, r) => Math.max(m, typeof r.seq === "number" ? r.seq : 0), 0), corruptLines, snapshots };
  }
}
