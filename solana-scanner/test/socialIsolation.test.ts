import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The social module is a self-contained, read-only layer: it does not call the network,
 * the clock or the environment, and no existing scorer depends on it. Therefore the
 * Opportunity / Risk / Quality / Confidence scores cannot be changed by it.
 */

const here = new URL("../src/social/", import.meta.url);
const files = readdirSync(here).filter((f) => f.endsWith(".ts"));
const read = (u: URL) => readFileSync(u, "utf8");

test("the module exists with its expected files", () => {
  for (const f of ["types.ts", "validate.ts", "ledger.ts", "config.ts", "dataConfidence.ts", "format.ts", "index.ts"]) assert.ok(files.includes(f), f);
});

test("src/social imports nothing from the scoring, final, wallets, onchain, outcomes, api, history, rpc or ui layers", () => {
  const forbidden = /from\s+["']\.\.\/(scoring|final|wallets|onchain|outcomes|domain|api|history|rpc|ui)\//;
  for (const f of files) assert.doesNotMatch(read(new URL(f, here)), forbidden, f);
});

test("src/social performs no I/O: no network, no environment, no clock, no randomness, no dynamic import", () => {
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|process\.env|Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random\s*\(|\brequire\s*\(|\bimport\s*\(|node:(fs|http|https|net|child_process)/;
  for (const f of files) assert.doesNotMatch(read(new URL(f, here)), banned, f);
});

test("no other source file imports the social module (existing scores cannot depend on it)", () => {
  for (const dir of ["../src/", "../server/", "../scripts/"]) {
    const root = new URL(dir, import.meta.url);
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel) || rel.replaceAll("\\", "/").startsWith("social/") || rel.replaceAll("\\", "/").startsWith("detective/")) continue;
      assert.doesNotMatch(read(new URL(rel, root)), /from\s+["'][^"']*\/social\//, `${dir}${rel}`);
    }
  }
});

test("the existing score configuration does not mention the evidence ledger", () => {
  const cfg = read(new URL("../src/scoring/config.ts", import.meta.url));
  assert.doesNotMatch(cfg, /social|evidence|ledger/i);
});
