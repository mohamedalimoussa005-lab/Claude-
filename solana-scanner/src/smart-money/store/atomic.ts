/** Atomic file writes: write a temp file, fsync it, rename over the target. A reader never sees a half-written file. */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

export const atomicWriteJson = (path: string, value: unknown): void => atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
