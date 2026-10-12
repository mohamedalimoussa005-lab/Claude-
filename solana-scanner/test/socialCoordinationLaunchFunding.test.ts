import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeLaunch, traceFunding, entityMap, withConfig, DEFAULT_CONFIG } from "../src/social/coordination/index.ts";
import { BASE_SLOT, SOL, addr, cov, mapProvider, organicFunding, organicLaunch, prng, sig, swapEvent } from "./helpers/coordination.ts";
import { MINT } from "./helpers/coordination.ts";

const ents = entityMap();
const launchOf = (swaps: ReturnType<typeof swapEvent>[], over: Parameters<typeof analyzeLaunch>[0] extends infer A ? Partial<A> : never = {}) =>
  analyzeLaunch({ mint: MINT, swaps, creator: null, entities: ents, supplyRaw: 1_000_000_000_000n, coverage: cov(), ...over });

// ---------------------------------------------------------------- launch

test("launch: cohort = first distinct buyers; the creator and known entities are kept apart", () => {
  const creator = addr("creator");
  const router = addr("public-bot");
  const e = entityMap({ [router]: { kind: "bot", label: "bot public" } });
  const swaps = [
    swapEvent(1, BASE_SLOT, creator, "buy", 5_000n, SOL),
    swapEvent(2, BASE_SLOT, router, "buy", 5_000n, SOL),
    swapEvent(3, BASE_SLOT + 1, addr(1), "buy", 1_000n, SOL / 2n),
    swapEvent(4, BASE_SLOT + 2, addr(2), "buy", 1_000n, SOL / 3n),
  ];
  const r = launchOf(swaps, { creator, entities: e });
  assert.deepEqual(r.cohort.map((m) => m.wallet), [addr(1), addr(2)]);
  assert.equal(r.creatorBuys.length, 1);
  assert.ok(r.excluded.some((x) => x.wallet === router && x.reason.includes("bot")));
  assert.ok(r.excluded.some((x) => x.wallet === creator));
});

test("launch: dust buys do not enter the cohort", () => {
  const r = launchOf([swapEvent(1, BASE_SLOT, addr(1), "buy", 1n, 10_000n), swapEvent(2, BASE_SLOT, addr(2), "buy", 1n, SOL)]);
  assert.deepEqual(r.cohort.map((m) => m.wallet), [addr(2)]);
});

test("launch: the cohort size is configurable and a cap is reported", () => {
  const swaps = Array.from({ length: 10 }, (_, i) => swapEvent(i + 1, BASE_SLOT + i, addr(i), "buy", 1000n, SOL));
  const r = launchOf(swaps, { cfg: withConfig({ launch: { cohortSize: 4 } }) });
  assert.equal(r.cohort.length, 4);
  assert.ok(r.notes.some((n) => n.includes("plafonnée")));
});

test("launch: an incomplete history is never presented as the launch", () => {
  const r = launchOf([swapEvent(1, BASE_SLOT, addr(1), "buy", 1000n, SOL)], { coverage: cov({ signaturesComplete: false, transactionsMissing: 3 }) });
  assert.equal(r.launchObserved, false);
  assert.ok(r.notes.some((n) => n.includes("historique incomplet")));
  assert.ok(r.notes.some((n) => n.includes("3 transaction")));
});

test("launch: empty input is reported, not crashed on", () => {
  const r = launchOf([]);
  assert.equal(r.cohort.length, 0);
  assert.equal(r.firstSlot, null);
  assert.ok(r.notes.some((n) => n.includes("aucun swap")));
});

test("launch: sells of cohort wallets inside the window are attributed", () => {
  const w = addr(1);
  const r = launchOf([swapEvent(1, BASE_SLOT, w, "buy", 1000n, SOL), swapEvent(2, BASE_SLOT + 5, w, "sell", 400n, SOL / 3n)]);
  assert.equal(r.cohort[0]!.soldBaseInWindow, 400n);
  assert.equal(r.cohort[0]!.sells, 1);
});

test("launch: share of supply and concentration indices", () => {
  const swaps = [swapEvent(1, BASE_SLOT, addr(1), "buy", 100_000_000_000n, SOL), swapEvent(2, BASE_SLOT + 1, addr(2), "buy", 100_000_000_000n, SOL), swapEvent(3, BASE_SLOT + 2, addr(3), "buy", 100_000_000_000n, SOL)];
  const r = launchOf(swaps);
  assert.equal(r.cohortSupplyShare, 0.3);
  assert.ok(Math.abs(r.hhiQuote! - 1 / 3) < 1e-9);
  assert.equal(r.giniQuote, 0);
});

test("launch: synchrony is a descriptive ratio to the launch's own pattern — no p-value, never calibrated", () => {
  const { swaps } = organicLaunch(prng(7), 35, 1000, 35);
  const spike = BASE_SLOT + 100;
  const coordinated = [...swaps, ...Array.from({ length: 12 }, (_, i) => swapEvent(2000 + i, spike, addr(`bundle-${i}`), "buy", 7_000_000n, (7n * SOL) / 100n))];
  const rc = launchOf(coordinated);
  const ro = launchOf(swaps);
  assert.equal(rc.sync.calibrated, false);
  assert.ok(!("pValue" in rc.sync) && !("unusual" in rc.sync), "the old uncalibrated p-value and verdict are gone");
  assert.ok(rc.sync.ratio! > 1.3 * ro.sync.ratio!, `spike ratio ${rc.sync.ratio} vs organic ${ro.sync.ratio}`);
  // the measure is stable: organic launches sit around 1 (their own pattern) whatever the heat
  for (const mean of [6, 12, 35]) {
    const r = launchOf(organicLaunch(prng(mean), 40, 1000, mean).swaps);
    assert.ok(r.sync.ratio! > 0.5 && r.sync.ratio! < 2, `mean ${mean}: ratio ${r.sync.ratio}`);
  }
});

test("launch: result does not depend on input order", () => {
  const { swaps } = organicLaunch(prng(3), 25);
  const a = launchOf(swaps);
  const b = launchOf([...swaps].reverse());
  assert.deepEqual(a.cohort.map((m) => m.wallet), b.cohort.map((m) => m.wallet));
  assert.equal(a.sync.observedPairs, b.sync.observedPairs);
});

// ---------------------------------------------------------------- funding

const F1 = addr("funder-1");
const T0 = 1_700_000_000;

test("funding: first funding is the earliest transfer above the minimum", () => {
  const w = addr("w");
  const provider = mapProvider({
    [w]: [
      { from: addr("dust"), lamports: 1_000n, slot: 100, n: 1 }, // below minimum: ignored
      { from: addr("second"), lamports: SOL, slot: 300, n: 2 },
      { from: addr("first"), lamports: SOL, slot: 200, n: 3 },
    ],
    [addr("first")]: [],
  });
  const r = traceFunding({ cohort: [w], provider, entities: ents });
  assert.equal(r.wallets[0]!.chain[0]!.from, addr("first"));
  assert.equal(r.wallets[0]!.chain[0]!.signature, sig(3));
});

test("funding: two hops by default, hop count is configurable", () => {
  const w = addr("w");
  const mk = () => mapProvider({ [w]: [{ from: addr("a"), lamports: SOL, slot: 10, n: 1 }], [addr("a")]: [{ from: addr("b"), lamports: 2n * SOL, slot: 5, n: 2 }], [addr("b")]: [{ from: addr("c"), lamports: 3n * SOL, slot: 1, n: 3 }] });
  const two = traceFunding({ cohort: [w], provider: mk(), entities: ents });
  assert.deepEqual(two.wallets[0]!.chain.map((c) => c.from), [addr("a"), addr("b")]);
  assert.equal(two.wallets[0]!.terminal.reason, "max_hops");
  const one = traceFunding({ cohort: [w], provider: mk(), entities: ents, cfg: withConfig({ funding: { maxHops: 1 } }) });
  assert.deepEqual(one.wallets[0]!.chain.map((c) => c.from), [addr("a")]);
  const three = traceFunding({ cohort: [w], provider: mk(), entities: ents, cfg: withConfig({ funding: { maxHops: 3 } }) });
  assert.deepEqual(three.wallets[0]!.chain.map((c) => c.from), [addr("a"), addr("b"), addr("c")]);
});

test("funding: the wallet limit is configurable and the rest is reported as not traced", () => {
  const wallets = Array.from({ length: 8 }, (_, i) => addr(`w${i}`));
  const r = traceFunding({ cohort: wallets, provider: organicFunding(prng(1), wallets), entities: ents, cfg: withConfig({ funding: { maxWallets: 5 } }) });
  assert.equal(r.wallets.length, 5);
  assert.equal(r.notTraced.length, 3);
  assert.ok(r.notes.some((n) => n.includes("non remontés")));
  assert.equal(traceFunding({ cohort: wallets, provider: organicFunding(prng(1), wallets), entities: ents }).wallets.length, 8, "default limit is 50");
});

test("funding: a shared non-neutral funder is a discriminating source with similar amounts and a burst", () => {
  const ws = Array.from({ length: 6 }, (_, i) => addr(`bundle${i}`));
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  ws.forEach((w, i) => (map[w] = [{ from: F1, lamports: 2n * SOL + BigInt(i) * 1000n, slot: 1000 + i, n: 100 + i }]));
  const r = traceFunding({ cohort: ws, provider: mapProvider({ ...map, [F1]: [{ from: addr("origin"), lamports: 20n * SOL, slot: 10, n: 9 }] }), entities: ents });
  const s = r.shared.find((x) => x.source === F1 && x.hop === 1)!;
  assert.equal(s.wallets.length, 6);
  assert.equal(s.discriminating, true);
  assert.equal(s.similarAmounts, true);
  assert.equal(s.burst, true);
  assert.equal(s.cohortShare, 1);
});

test("funding (false positive): a shared exchange is reported but never discriminating", () => {
  const cex = addr("exchange-hot");
  const e = entityMap({ [cex]: { kind: "exchange", label: "exchange X" } });
  const ws = Array.from({ length: 10 }, (_, i) => addr(`cexuser${i}`));
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  ws.forEach((w, i) => (map[w] = [{ from: cex, lamports: 2n * SOL, slot: 1000 + i, n: 200 + i }]));
  const r = traceFunding({ cohort: ws, provider: mapProvider(map), entities: e });
  const s = r.shared.find((x) => x.source === cex)!;
  assert.equal(s.discriminating, false);
  assert.equal(s.entity?.kind, "exchange");
  assert.ok(r.wallets.every((w) => w.terminal.reason === "neutral_entity"));
});

test("funding (false positive): a very active funder is a probable service, not a discriminating source", () => {
  const busy = addr("busy");
  const ws = Array.from({ length: 5 }, (_, i) => addr(`u${i}`));
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  ws.forEach((w, i) => (map[w] = [{ from: busy, lamports: SOL, slot: 10 + i, n: 300 + i }]));
  const capped = traceFunding({ cohort: ws, provider: mapProvider({ ...map, [busy]: [] }, { [busy]: { activityCapped: true } }), entities: ents });
  assert.equal(capped.shared[0]!.probableService, true);
  assert.equal(capped.shared[0]!.discriminating, false);
  const fan = traceFunding({ cohort: ws, provider: mapProvider({ ...map, [busy]: [] }, { [busy]: { sampledFanout: 150 } }), entities: ents });
  assert.equal(fan.shared[0]!.discriminating, false);
  const calm = traceFunding({ cohort: ws, provider: mapProvider({ ...map, [busy]: [] }, { [busy]: { sampledFanout: 3 } }), entities: ents });
  assert.equal(calm.shared[0]!.discriminating, true);
});

test("funding: organic wallets with distinct funders produce no shared source", () => {
  const ws = Array.from({ length: 30 }, (_, i) => addr(`org${i}`));
  const r = traceFunding({ cohort: ws, provider: organicFunding(prng(5), ws), entities: ents });
  assert.equal(r.shared.length, 0);
});

test("funding: a funder that is itself in the cohort is an internal link", () => {
  const a = addr("a");
  const b = addr("b");
  const r = traceFunding({ cohort: [a, b], provider: mapProvider({ [a]: [{ from: addr("x"), lamports: SOL, slot: 1, n: 1 }], [b]: [{ from: a, lamports: SOL, slot: 5, n: 2 }], [addr("x")]: [] }), entities: ents });
  assert.deepEqual(r.internalLinks.map((l) => [l.from, l.to, l.hop]), [[a, b, 1]]);
});

test("funding: missing and partial histories are reported explicitly", () => {
  const a = addr("a");
  const b = addr("b");
  const c = addr("c");
  const provider = mapProvider({ [a]: null, [b]: [{ from: addr("x"), lamports: SOL, slot: 1, n: 1 }], [c]: [], [addr("x")]: [] }, { [b]: { coverage: cov({ signaturesComplete: false }) } });
  const r = traceFunding({ cohort: [a, b, c], provider, entities: ents });
  assert.deepEqual(r.unavailable, [a]);
  assert.equal(r.wallets.find((w) => w.wallet === a)!.terminal.reason, "history_unavailable");
  assert.equal(r.wallets.find((w) => w.wallet === b)!.partial, true);
  assert.equal(r.wallets.find((w) => w.wallet === c)!.terminal.reason, "no_funding_found");
  assert.ok(r.notes.some((n) => n.includes("sans historique")));
  assert.ok(r.notes.some((n) => n.includes("historique partiel")));
});

test("funding: incomplete history with no transfer is not reported as 'no funding'", () => {
  const a = addr("a");
  const r = traceFunding({ cohort: [a], provider: mapProvider({ [a]: [] }, { [a]: { coverage: cov({ signaturesComplete: false }) } }), entities: ents });
  assert.equal(r.wallets[0]!.terminal.reason, "history_incomplete_no_funding");
});

test("funding: result does not depend on cohort order", () => {
  const ws = Array.from({ length: 6 }, (_, i) => addr(`o${i}`));
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  ws.forEach((w, i) => (map[w] = [{ from: i < 4 ? F1 : addr(`d${i}`), lamports: SOL, slot: 10 + i, n: 400 + i }]));
  const a = traceFunding({ cohort: ws, provider: mapProvider(map), entities: ents });
  const b = traceFunding({ cohort: [...ws].reverse(), provider: mapProvider(map), entities: ents });
  assert.deepEqual(a.shared.map((s) => [s.source, [...s.wallets].sort()]), b.shared.map((s) => [s.source, [...s.wallets].sort()]));
});

test("defaults are untouched by tests", () => {
  assert.equal(DEFAULT_CONFIG.funding.maxHops, 2);
  assert.equal(T0 > 0, true);
});
