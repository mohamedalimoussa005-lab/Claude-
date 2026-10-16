/**
 * Append-only JSONL log. A crash can leave a torn last line: reads skip lines
 * that do not parse (and count them), appends start on a fresh line.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface JsonlRead<T> {
  records: T[];
  corruptLines: number;
}

export function readJsonl<T>(path: string): JsonlRead<T> {
  if (!existsSync(path)) return { records: [], corruptLines: 0 };
  const records: T[] = [];
  let corruptLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      corruptLines++;
    }
  }
  return { records, corruptLines };
}

function endsWithNewline(path: string): boolean {
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function appendJsonl(path: string, records: unknown[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const prefix = existsSync(path) && !endsWithNewline(path) ? "\n" : "";
  appendFileSync(path, `${prefix}${records.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
