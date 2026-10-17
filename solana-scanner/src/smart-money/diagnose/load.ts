/**
 * Reads what a previous run left on disk: the history cache and the saved wallet reports. Strictly read-only:
 * no lock, no directory creation, no write; files are only opened for reading.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryCacheSnapshot } from "../../history/cache.ts";
import type { HistoryTx } from "../../history/types.ts";
import type { WalletReport } from "../ingest/report.ts";

export interface LocalData {
  dir: string;
  cache: { present: boolean; readable: boolean; snapshot: HistoryCacheSnapshot | null; bySignature: Map<string, HistoryTx> };
  /** Saved reports, newest write first, keyed by file name. */
  reports: { name: string; writtenAt: number | null; report: WalletReport }[];
  filesRead: string[];
  problems: string[];
}

function readJson(path: string, problems: string[], label: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    problems.push(`${label} illisible ou corrompu`);
    return null;
  }
}

export function loadLocalData(dir: string): LocalData {
  const problems: string[] = [];
  const filesRead: string[] = [];
  const cachePath = join(dir, "cache", "history.json");
  const present = existsSync(cachePath);
  let snapshot: HistoryCacheSnapshot | null = null;
  if (present) {
    filesRead.push("cache/history.json");
    const raw = readJson(cachePath, problems, "cache/history.json") as HistoryCacheSnapshot | null;
    if (raw && Array.isArray(raw.txs) && raw.wallets && typeof raw.wallets === "object") snapshot = raw;
    else if (raw) problems.push("cache/history.json : format inattendu");
  }
  const bySignature = new Map<string, HistoryTx>();
  for (const t of snapshot?.txs ?? []) bySignature.set(t.signature, t);

  const reports: LocalData["reports"] = [];
  const snapDir = join(dir, "snapshots");
  if (existsSync(snapDir)) {
    for (const f of readdirSync(snapDir).filter((x) => x.startsWith("wallet-") && x.endsWith(".json")).sort()) {
      filesRead.push(`snapshots/${f}`);
      const raw = readJson(join(snapDir, f), problems, `snapshots/${f}`) as { schema?: string; writtenAt?: number; data?: WalletReport } | null;
      if (raw?.schema === "smart-money.snapshot/1" && raw.data && typeof raw.data.wallet === "string" && raw.data.history) reports.push({ name: f.slice(0, -5), writtenAt: typeof raw.writtenAt === "number" ? raw.writtenAt : null, report: raw.data });
      else if (raw) problems.push(`snapshots/${f} : format inattendu`);
    }
  }
  reports.sort((a, b) => (b.writtenAt ?? 0) - (a.writtenAt ?? 0));
  return { dir, cache: { present, readable: snapshot !== null, snapshot, bySignature }, reports, filesRead, problems };
}

/** Wallets we have something about. */
export function walletsIn(d: LocalData): string[] {
  return [...new Set([...Object.keys(d.cache.snapshot?.wallets ?? {}), ...d.reports.map((r) => r.report.wallet)])];
}

export function txsOf(d: LocalData, wallet: string): HistoryTx[] {
  const out: HistoryTx[] = [];
  for (const s of d.cache.snapshot?.wallets[wallet] ?? []) {
    const t = d.cache.bySignature.get(s);
    if (t) out.push(t);
  }
  return out;
}
