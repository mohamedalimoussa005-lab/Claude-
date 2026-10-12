import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchSections } from "../src/detective/launch.ts";
import { Meter, budgeted } from "../src/detective/meter.ts";
import { withMode } from "../src/detective/modes.ts";
import { EvidenceLedger } from "../src/social/ledger.ts";
import { loadCapture } from "./fixtures/social/coordination/load.ts";
import type { TokenKey } from "./fixtures/social/coordination/load.ts";
import { analyzeCoordination, normalizeTx } from "../src/social/coordination/index.ts";
import { providerOf, inputOf } from "./fixtures/social/coordination/load.ts";
import { replayRpc } from "./helpers/detectiveCapture.ts";
import type { Resolution } from "../src/detective/resolve.ts";

const res = {} as Resolution;
async function launch(key: TokenKey, over: Parameters<typeof withMode>[1] = {}, maxCalls = 5000, pad = 0) {
  const c = loadCapture(key);
  const mode = withMode("profond", over);
  const meter = new Meter("profond", maxCalls, 3_600_000);
  const ledger = new EvidenceLedger();
  const rpc = replayRpc(c, { mintPad: pad });
  const out = await buildLaunchSections({ rpc: budgeted(rpc, meter), mint: c.mint, res, mode, meter, ledger, observedAt: "2026-10-12T10:00:00.000Z", creator: c.creator, supplyRaw: c.supplyRaw });
  for (const r of out.record) r(ledger);
  return { out, meter, ledger, rpc, c };
}

test("replay A/B/F: the launch is reached, the cohort matches the 5C engine, funding is traced", async () => {
  for (const key of ["A", "B", "F"] as const) {
    const { out, meter, c } = await launch(key);
    const fb = out.firstBuyers.data as { launchObserved: boolean; cohortSize: number };
    assert.equal(fb.launchObserved, true, key);
    assert.notEqual(out.firstBuyers.status, "unknown", key);
    const direct = analyzeCoordination(inputOf(c));
    assert.equal(fb.cohortSize, Math.min(direct.launch.cohort.length, 50), `${key} cohort size equals 5C`);
    assert.ok(meter.calls > 0 && meter.limitsReached.every((l) => !l.includes("lancement non atteint")), key);
    assert.ok(out.funding.data && (out.funding.data as { traced: number }).traced > 0, key);
  }
});

test("replay C: the launch is NOT reached → flagged, 'oldest buyers read', never presented as launch buyers", async () => {
  const { out, meter } = await launch("C", { launch: { maxSignaturePages: 1 } }, 5000, 996);
  const fb = out.firstBuyers.data as { launchObserved: boolean };
  assert.equal(fb.launchObserved, false);
  assert.ok(out.firstBuyers.unknowns.some((u) => /lancement réel/.test(u)));
  assert.ok(meter.limitsReached.some((l) => /lancement non atteint/.test(l)));
  assert.notEqual(out.firstBuyers.status, "ok");
  assert.ok(!out.firstBuyers.findings.some((f) => /dans la fenêtre de lancement/.test(f.text)), "never worded as launch buyers");
});

test("replay C with only failed signatures in the pages read: UNKNOWN, limit reported", async () => {
  const { out, meter } = await launch("C", { launch: { maxSignaturePages: 2 } }, 5000, 5000);
  assert.equal(out.firstBuyers.status, "unknown");
  assert.ok(meter.limitsReached.some((l) => /plafond de 2 page/.test(l)));
});

test("budget: exhausted before launch → every section UNKNOWN, no invented value", async () => {
  const { out } = await launch("A", {}, 0);
  for (const s of [out.firstBuyers, out.funding, out.repetitive]) {
    assert.equal(s.status, "unknown");
    assert.equal(s.findings.length, 0);
    assert.ok(s.unknowns.length > 0);
  }
});

test("budget: running out during funding traces fewer wallets, reports the limit and keeps funding UNKNOWN (not zero)", async () => {
  const full = await launch("A");
  const calls = full.meter.calls;
  const { out, meter } = await launch("A", {}, Math.floor(calls * 0.5));
  assert.ok(meter.limitsReached.length > 0);
  assert.equal(meter.exhausted, true);
  const f = out.funding.data as { known: number; unknown: number; traced: number };
  const ff = full.out.funding.data as { known: number };
  assert.ok(f.known <= ff.known);
  assert.ok(out.funding.unknowns.length > 0 || f.unknown > 0 || (out.funding.data as { notTraced: number }).notTraced > 0);
  assert.notEqual(out.funding.status, "ok");
});

test("ledger: coordination evidence anchored on signatures and slots, no hypothesis", async () => {
  const { ledger } = await launch("B");
  const all = ledger.all();
  assert.ok(all.length > 0);
  assert.ok(!all.some((e) => e.status === "HYPOTHESIS" || e.type === "coordination_assessment"));
  assert.ok(all.some((e) => typeof e.signature === "string" && e.signature.length > 30), "has signature anchors");
  assert.ok(all.some((e) => typeof e.slot === "number"), "has slot anchors");
});

test("wording: no accusation, no probability, hypotheses declared disabled, group wording stays descriptive", async () => {
  for (const key of ["A", "B", "F"] as const) {
    const { out } = await launch(key);
    const text = [out.firstBuyers, out.funding, out.repetitive].flatMap((s) => [...s.findings.map((f) => f.text), ...s.unknowns, ...s.limits]).join("\n");
    assert.doesNotMatch(text, /fraude avérée|arnaque|scam|rug|manipulation avérée|coordination avérée/i, key);
    assert.match(text, /DÉSACTIVÉES/);
    for (const g of (out.funding.data as { groups: { hypothesisEligible: boolean }[] }).groups) assert.equal(g.hypothesisEligible, false);
  }
});

test("read-only: only read methods are called, and the call count equals the meter", async () => {
  const { rpc, meter } = await launch("F");
  assert.ok(rpc.calls.every((c) => ["getSignaturesForAddress", "getTransaction"].includes(c.method)));
  assert.equal(rpc.calls.length, meter.calls);
  void normalizeTx; void providerOf;
});
