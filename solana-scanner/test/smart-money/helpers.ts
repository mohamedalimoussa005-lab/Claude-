import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export function tmpDir(prefix = "sm-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export const closeTo = (a: number | null, b: number, eps = 1e-9): boolean => a !== null && Math.abs(a - b) <= eps;
