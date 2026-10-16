import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OWN = join(ROOT, "src", "smart-money");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".cache" || f === "data") return [];
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

const imports = (src: string): string[] => [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);

test("the agent never imports DETECTIVE, BREAKING SIGNAL, the UI or any notifier", () => {
  for (const file of walk(OWN)) {
    for (const spec of imports(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) {
        assert.ok(spec.startsWith("node:"), `${relative(ROOT, file)}: third-party import ${spec}`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      const rel = relative(ROOT, target).split(sep).join("/");
      assert.ok(!rel.startsWith("src/detective/"), `${relative(ROOT, file)} imports DETECTIVE (${spec})`);
      assert.ok(!rel.startsWith("src/ui/") && !rel.startsWith("server/"), `${relative(ROOT, file)} imports UI/server (${spec})`);
      assert.ok(!/telegram|notify/i.test(rel), `${relative(ROOT, file)} imports a notifier (${spec})`);
    }
  }
});

test("phases 0-2 make no network call", () => {
  for (const file of walk(OWN)) {
    const src = readFileSync(file, "utf8");
    assert.ok(!/\bfetch\s*\(/.test(src), `${relative(ROOT, file)} calls fetch`);
    for (const spec of imports(src)) assert.ok(!/^node:(https?|net|tls|dgram|http2)$/.test(spec), `${relative(ROOT, file)} imports ${spec}`);
  }
});

test("nothing outside the agent imports it (DETECTIVE / BREAKING SIGNAL are unaffected)", () => {
  const allowed = (rel: string) => rel.startsWith("src/smart-money/") || rel.startsWith("test/smart-money/") || rel.startsWith("scripts/smart-money.");
  for (const dir of ["src", "server", "scripts", "test"]) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (allowed(rel)) continue;
      for (const spec of imports(readFileSync(file, "utf8"))) assert.ok(!/smart-money/.test(spec), `${rel} imports the Smart Money agent (${spec})`);
    }
  }
});

test("the agent reuses the shared history / wallet components instead of copying them", () => {
  const build = readFileSync(join(OWN, "ledger", "build.ts"), "utf8");
  assert.match(build, /history\/classify\.ts/);
  assert.match(build, /wallets\/trades\.ts/);
  const store = readFileSync(join(OWN, "store", "store.ts"), "utf8");
  assert.match(store, /outcomes\/lock\.ts/);
});
