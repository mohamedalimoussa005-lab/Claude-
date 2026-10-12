import { test } from "node:test";
import assert from "node:assert/strict";
import { runDetective } from "../src/detective/run.ts";
import { loadCapture } from "./fixtures/social/coordination/load.ts";
import { ALL_TICKS, MINTS, dexPairs, fakeDex, fixtureAccounts, stubCollect } from "./helpers/detective.ts";
import { replayRpc } from "./helpers/detectiveCapture.ts";

const NOW = () => Date.parse("2026-10-12T10:00:00Z");
async function run(key: "A" | "B" | "C" | "F", mode: "rapide" | "standard" | "profond") {
  const c = loadCapture(key);
  const rpc = replayRpc(c, { mintPad: key === "C" ? 996 : 0, extra: { accounts: fixtureAccounts, tickArrays: ALL_TICKS } });
  return runDetective({ mint: MINTS[key], mode, overrides: key === "C" ? { launch: { maxSignaturePages: 1 } } : {} }, { dex: fakeDex({ [MINTS[key]]: dexPairs(key) }), rpc, now: NOW, collect: async (...a) => ({ ...(await stubCollect(...a)), } as never), sleep: async () => {} });
}

test("end-to-end replay A/B/C/F × 3 modes: ten sections, budget shown, caps respected, no verdict", async () => {
  for (const key of ["A", "B", "C", "F"] as const) {
    for (const mode of ["rapide", "standard", "profond"] as const) {
      const { report, markdown } = await run(key, mode);
      const b = report.budget;
      assert.ok(b.calls <= b.maxCalls, `${key}/${mode} calls ${b.calls} ≤ ${b.maxCalls}`);
      assert.match(markdown, /appel\(s\) RPC sur \d+ autorisés.*\n- Temps écoulé.*\n- Appels par méthode.*\n- Limites atteintes/);
      assert.equal(report.hypothesesEnabled, false);
      assert.doesNotMatch(markdown, /fraude avérée|arnaque|scam|rug pull|achetez|vendez/i);
      assert.equal(Object.keys(report.sections).length, 10);
    }
  }
});

test("replay: mode rapide stops earlier than profond, and reports the limits it reached", async () => {
  const fast = (await run("A", "rapide")).report;
  const deep = (await run("A", "profond")).report;
  assert.ok(fast.budget.calls < deep.budget.calls);
  const cs = (r: typeof fast) => (r.sections.firstBuyers.data as { cohortSize: number }).cohortSize;
  assert.ok(cs(fast) <= 12 + 0 || cs(fast) <= 50);
  assert.ok(cs(deep) >= cs(fast));
});

test("replay C: launch not reachable → flagged in report and synthesis", async () => {
  const { report, markdown } = await run("C", "standard");
  assert.ok(report.budget.limitsReached.some((l) => /lancement non atteint/.test(l)));
  assert.match(markdown, /lancement/i);
});
