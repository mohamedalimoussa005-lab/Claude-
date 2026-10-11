import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeLaunch, traceFunding, clusterCohort, analyzeWash, entityMap, withConfig, isRoundAmount, matchRoundTrips, DEFAULT_CONFIG } from "../src/social/coordination/index.ts";
import type { SwapEvent, TokenTransfer } from "../src/social/coordination/index.ts";
import { BASE_SLOT, MINT, SOL, addr, cov, mapProvider, organicFunding, organicLaunch, prng, sig, swapEvent } from "./helpers/coordination.ts";

const ents = entityMap();

function run(swaps: SwapEvent[], provider: ReturnType<typeof mapProvider>, opts: { transfers?: TokenTransfer[]; entities?: ReturnType<typeof entityMap>; cfg?: typeof DEFAULT_CONFIG } = {}) {
  const e = opts.entities ?? ents;
  const launch = analyzeLaunch({ mint: MINT, swaps, creator: null, entities: e, supplyRaw: 1_000_000_000_000n, coverage: cov(), cfg: opts.cfg });
  const funding = traceFunding({ cohort: launch.cohort.map((m) => m.wallet), provider, entities: e, cfg: opts.cfg });
  const cluster = clusterCohort({ cohort: launch.cohort, swaps, funding, transfers: opts.transfers ?? [], supplyRaw: 1_000_000_000_000n, cfg: opts.cfg });
  return { launch, funding, cluster };
}

const FUNDER = addr("shared-funder");
/** `n` wallets funded by one source (similar amounts, same minute), buying the same slot with similar non-round amounts. */
function bundle(n: number, o: { fund?: boolean; sameSlot?: boolean; amount?: (i: number) => bigint; sellAfter?: number | null; id?: string } = {}) {
  const id = o.id ?? "b";
  const swaps: SwapEvent[] = [];
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  const wallets = Array.from({ length: n }, (_, i) => addr(`${id}-w${i}`));
  wallets.forEach((w, i) => {
    const q = (o.amount ?? ((k) => 770_000_000n + BigInt(k) * 1_000_000n))(i);
    swaps.push(swapEvent(5000 + i + (id === "b" ? 0 : 500), BASE_SLOT + 40 + (o.sameSlot === false ? i * 30 : 0), w, "buy", q * 1000n, q));
    if (o.sellAfter !== null && o.sellAfter !== undefined) swaps.push(swapEvent(7000 + i + (id === "b" ? 0 : 500), BASE_SLOT + 40 + o.sellAfter + (i % 2), w, "sell", q * 900n, (q * 12n) / 10n));
    map[w] = [{ from: o.fund === false ? addr(`own-${id}-${i}`) : FUNDER, lamports: 1_000_000_000n + BigInt(i) * 500_000n, slot: 1000 + i, n: 9000 + i + (id === "b" ? 0 : 500) }];
  });
  return { swaps, map, wallets };
}

// ---------------------------------------------------------------- clustering

test("cluster: funding + timing + amount + exit together form a group eligible for a (never proven) hypothesis", () => {
  const b = bundle(8, { sellAfter: 100 });
  const org = organicLaunch(prng(11), 30);
  const r = run([...org.swaps, ...b.swaps], mapProvider({ ...b.map, ...Object.fromEntries(org.wallets.map((w, i) => [w, [{ from: addr(`f${i}`), lamports: SOL, slot: 5, n: 30_000 + i }]])), [FUNDER]: [] }));
  const g = r.cluster.groups.find((x) => x.strength === "multi_signal")!;
  assert.ok(g, "a multi-signal group is found");
  assert.ok(g.wallets.length >= 8 && b.wallets.every((w) => g.wallets.includes(w)));
  assert.ok(["funding", "timing", "amount", "exit"].every((f) => (g.families as string[]).includes(f)));
  assert.equal(g.hypothesisEligible, true);
  assert.ok(g.counterExplanations.length >= 4);
  assert.ok(g.anchors.length > 0);
});

test("cluster: funding + timing alone never make a hypothesis, even if the family threshold is lowered", () => {
  // different amounts (not similar) and no coordinated exit: only funding and timing remain
  const b = bundle(6, { amount: (i) => BigInt(300_000_000 + i * 170_000_000) });
  const provider = mapProvider({ ...b.map, [FUNDER]: [] });
  for (const cfg of [DEFAULT_CONFIG, withConfig({ cluster: { minFamiliesForHypothesis: 2 } })]) {
    const r = run(b.swaps, provider, { cfg });
    const g = r.cluster.groups.find((x) => x.strength === "multi_signal");
    assert.ok(g, "funding+timing is reported as a multi-signal group");
    assert.deepEqual([...g.families].sort(), ["funding", "timing"]);
    assert.equal(g.hypothesisEligible, false, "two ordinary signals are not enough to write a coordination hypothesis");
  }
});

test("cluster: a shared funder alone (no other family) is only a weak single-signal group", () => {
  const b = bundle(6, { sameSlot: false, amount: (i) => BigInt(300_000_000 + i * 170_000_000) });
  const r = run(b.swaps, mapProvider({ ...b.map, [FUNDER]: [] }));
  assert.equal(r.cluster.groups.filter((g) => g.strength === "multi_signal").length, 0);
  const weak = r.cluster.groups.find((g) => g.strength === "single_signal")!;
  assert.deepEqual(weak.families, ["funding"]);
  assert.equal(weak.hypothesisEligible, false);
});

test("cluster: synchronous buys alone (no shared funding) are not a group", () => {
  const b = bundle(10, { fund: false, amount: (i) => BigInt(300_000_000 + i * 170_000_000) });
  const provider = mapProvider({ ...Object.fromEntries(b.wallets.map((w, i) => [w, [{ from: addr(`own${i}`), lamports: SOL, slot: 5, n: 40_000 + i }]])) });
  const r = run(b.swaps, provider);
  assert.equal(r.cluster.groups.length, 0);
  assert.ok(r.cluster.singleFamilyPairs.timing > 0, "the timing coincidences are counted, not hidden");
});

test("cluster (false positive): wallets funded by an exchange and buying together are not grouped by funding", () => {
  const cex = addr("cex");
  const e = entityMap({ [cex]: { kind: "exchange", label: "exchange X" } });
  const varied = bundle(12, { fund: false, amount: (i) => BigInt(300_000_000 + i * 170_000_000) });
  const map = (b: { wallets: string[] }) => Object.fromEntries(b.wallets.map((w, i) => [w, [{ from: cex, lamports: SOL, slot: 10 + i, n: 41_000 + i }]]));
  const r = run(varied.swaps, mapProvider(map(varied)), { entities: e });
  assert.equal(r.cluster.groups.length, 0, "a shared exchange plus synchronous buys is not a group");
  assert.ok(r.funding.shared.every((s) => !s.discriminating));
  // even with similar amounts on top: no funding family, and never a hypothesis
  const similar = bundle(12, { fund: false });
  const r2 = run(similar.swaps, mapProvider(map(similar)), { entities: e });
  assert.ok(r2.cluster.groups.every((g) => !g.families.includes("funding") && !g.hypothesisEligible));
});

test("cluster (false positive): round default amounts are not a similarity signal", () => {
  assert.equal(isRoundAmount(SOL), true);
  assert.equal(isRoundAmount(500_000_000n), true);
  assert.equal(isRoundAmount(777_000_000n), false);
  const b = bundle(8, { fund: false, amount: () => SOL });
  const r = run(b.swaps, mapProvider(Object.fromEntries(b.wallets.map((w, i) => [w, [{ from: addr(`z${i}`), lamports: SOL, slot: 5, n: 42_000 + i }]]))));
  assert.equal(r.cluster.singleFamilyPairs.amount, 0);
  assert.equal(r.cluster.groups.length, 0);
});

test("cluster (false positive): a public bot or router in the cohort is excluded before any grouping", () => {
  const bot = addr("public-sniper");
  const e = entityMap({ [bot]: { kind: "bot", label: "bot de snipe public" } });
  const b = bundle(5, { fund: false });
  const swaps = [...b.swaps, swapEvent(8000, BASE_SLOT + 40, bot, "buy", 1000n, 770_000_000n)];
  const r = run(swaps, mapProvider({}), { entities: e });
  assert.ok(!r.launch.cohort.some((m) => m.wallet === bot));
});

test("cluster (false positive): organic launches yield no hypothesis and no large group (30 seeds)", () => {
  let hypotheses = 0;
  let large = 0;
  let groups = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const o = organicLaunch(prng(seed * 977), 40);
    const r = run(o.swaps, organicFunding(prng(seed), o.wallets));
    hypotheses += r.cluster.groups.filter((g) => g.hypothesisEligible).length;
    large += r.cluster.groups.filter((g) => g.wallets.length >= 4).length;
    groups += r.cluster.groups.length;
  }
  assert.equal(hypotheses, 0);
  assert.equal(large, 0);
  assert.ok(groups <= 8, `${groups} small chance groups over 30 organic launches`);
});

test("cluster: direct token transfers between cohort wallets add the 'transfer' family", () => {
  const b = bundle(5, { amount: (i) => BigInt(300_000_000 + i * 170_000_000), sameSlot: false });
  const transfers: TokenTransfer[] = [
    { signature: sig(60_000), slot: BASE_SLOT + 500, blockTime: null, from: b.wallets[0]!, to: b.wallets[1]!, amount: 5n },
    { signature: sig(60_001), slot: BASE_SLOT + 501, blockTime: null, from: b.wallets[1]!, to: b.wallets[2]!, amount: 5n },
  ];
  const r = run(b.swaps, mapProvider({ ...b.map, [FUNDER]: [] }), { transfers });
  const g = r.cluster.groups.find((x) => x.strength === "multi_signal")!;
  assert.deepEqual(g.families, ["funding", "transfer"]);
  assert.deepEqual(g.wallets, [b.wallets[0]!, b.wallets[1]!, b.wallets[2]!].sort());
  assert.equal(g.hypothesisEligible, false, "two families: no hypothesis");
});

test("cluster: result does not depend on input order", () => {
  const b = bundle(7, { sellAfter: 80 });
  const o = organicLaunch(prng(2), 20);
  const prov = mapProvider({ ...b.map, [FUNDER]: [], ...Object.fromEntries(o.wallets.map((w, i) => [w, [{ from: addr(`g${i}`), lamports: SOL, slot: 9, n: 43_000 + i }]])) });
  const a = run([...o.swaps, ...b.swaps], prov);
  const c = run([...b.swaps, ...o.swaps].reverse(), prov);
  const view = (x: typeof a) => x.cluster.groups.map((g) => [g.id, g.wallets, g.families, g.strength]);
  assert.deepEqual(view(a), view(c));
});

// ---------------------------------------------------------------- wash volume

function organicTrading(seed: number, wallets = 60) {
  const rng = prng(seed);
  const swaps: SwapEvent[] = [];
  let n = 100_000 * seed;
  for (let i = 0; i < wallets; i++) {
    const w = addr(`trader-${seed}-${i}`);
    const slot = BASE_SLOT + Math.floor(rng() * 200_000);
    const q = BigInt(Math.floor(0.05e9 + rng() * 3e9));
    swaps.push(swapEvent(n++, slot, w, "buy", q * 1000n, q));
    if (rng() < 0.4) swaps.push(swapEvent(n++, slot + 5_000 + Math.floor(rng() * 80_000), w, "sell", q * 1000n, (q * BigInt(70 + Math.floor(rng() * 80))) / 100n));
  }
  return swaps;
}

test("wash: organic trading shows little round-trip volume and no flag", () => {
  let flagged = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = analyzeWash({ swaps: organicTrading(seed), transfers: [], entities: ents });
    assert.ok(r.roundTripShare !== null && r.roundTripShare < 0.1, `round trip share ${r.roundTripShare}`);
    if (r.flags.length > 0) flagged++;
  }
  assert.ok(flagged <= 1, `${flagged}/12 organic markets flagged`);
});

test("wash: repeated same-size buy/sell cycles by a few wallets are measured and flagged", () => {
  const swaps = [...organicTrading(3, 40)];
  let n = 900_000;
  const loopers = [addr("loop-a"), addr("loop-b"), addr("loop-c")];
  for (const w of loopers) {
    for (let k = 0; k < 25; k++) {
      const slot = BASE_SLOT + 20_000 + k * 100 + loopers.indexOf(w);
      swaps.push(swapEvent(n++, slot, w, "buy", 2_000_000n, 2n * SOL));
      swaps.push(swapEvent(n++, slot + 50, w, "sell", 2_000_000n, (2n * SOL * 995n) / 1000n));
    }
  }
  const r = analyzeWash({ swaps, transfers: [], entities: ents });
  assert.ok(r.roundTripShare! > 0.4, `share ${r.roundTripShare}`);
  assert.ok(r.roundTripWallets.includes(loopers[0]!));
  assert.ok(r.permutation!.pValue < 0.01, `p=${r.permutation!.pValue}`);
  assert.ok(r.permutation!.observedShare > r.permutation!.nullP95);
  assert.equal(r.cadence.filter((c) => c.metronomic).length, 3);
  assert.ok(r.flags.length >= 2);
  assert.ok(r.counterExplanations.length > 0);
});

test("wash (false positive): a known arbitrage bot or router is excluded from the judgement and counted apart", () => {
  const bot = addr("arb-bot");
  const e = entityMap({ [bot]: { kind: "bot", label: "bot d'arbitrage" } });
  const swaps = [...organicTrading(4, 30)];
  let n = 950_000;
  for (let k = 0; k < 40; k++) {
    swaps.push(swapEvent(n++, BASE_SLOT + 1000 + k * 40, bot, "buy", 1_000_000n, SOL));
    swaps.push(swapEvent(n++, BASE_SLOT + 1010 + k * 40, bot, "sell", 1_000_000n, SOL));
  }
  const r = analyzeWash({ swaps, transfers: [], entities: e });
  assert.ok(r.excludedQuote >= 80n * SOL);
  assert.ok(!r.roundTripWallets.includes(bot));
  assert.ok(r.roundTripShare! < 0.1);
  assert.ok(r.notes.some((x) => x.includes("exclus")));
});

test("wash: round trips respect the time window and the matched fraction", () => {
  const w = addr("w");
  const cfg = DEFAULT_CONFIG;
  const mk = (sellSlot: number, sellBase: bigint) => [swapEvent(1, BASE_SLOT, w, "buy", 1000n, SOL), swapEvent(2, sellSlot, w, "sell", sellBase, SOL)];
  const traders = (s: SwapEvent[]) => (i: number) => s[i]!.trader;
  assert.equal(matchRoundTrips(mk(BASE_SLOT + 100, 1000n), traders(mk(0, 0n)), cfg).length, 1);
  const late = mk(BASE_SLOT + 5000, 1000n); // 2000 s later
  assert.equal(matchRoundTrips(late, traders(late), cfg).length, 0, "outside the window");
  const small = mk(BASE_SLOT + 100, 300n);
  assert.equal(matchRoundTrips(small, traders(small), cfg).length, 0, "selling 30 % back is not a round trip");
  const wide = withConfig({ wash: { roundTripSeconds: 5000 } });
  assert.equal(matchRoundTrips(late, traders(late), wide).length, 1, "window is configurable");
});

test("wash: token transfer cycles (A→B→A, X→Y→Z→X) are found; a chain is not a cycle", () => {
  const [a, b, x, y, z, d] = [addr("ca"), addr("cb"), addr("cx"), addr("cy"), addr("cz"), addr("cd")];
  const t = (from: string, to: string, n: number): TokenTransfer => ({ signature: sig(n), slot: 1, blockTime: null, from, to, amount: 10n });
  const cyc = analyzeWash({ swaps: [], transfers: [t(a, b, 1), t(b, a, 2), t(x, y, 3), t(y, z, 4), t(z, x, 5), t(z, d, 6)], entities: ents });
  const sets = cyc.transferCycles.map((c) => [...new Set(c)].sort().join(","));
  assert.ok(sets.includes([a, b].sort().join(",")), "2-cycle");
  assert.ok(sets.includes([x, y, z].sort().join(",")), "3-cycle");
  assert.equal(cyc.transferCycles.length, 2);
  const chain = analyzeWash({ swaps: [], transfers: [t(a, b, 7), t(b, x, 8), t(x, d, 9)], entities: ents });
  assert.equal(chain.transferCycles.length, 0);
});

test("wash: permutation null model is deterministic for a seed and configurable", () => {
  const sw = organicTrading(5, 40);
  const a = analyzeWash({ swaps: sw, transfers: [], entities: ents });
  const b = analyzeWash({ swaps: [...sw].reverse(), transfers: [], entities: ents });
  assert.deepEqual(a.permutation, b.permutation);
  const c = analyzeWash({ swaps: sw, transfers: [], entities: ents, cfg: withConfig({ wash: { permutations: 50, seed: 9 } }) });
  assert.equal(c.permutation!.permutations, 50);
  assert.equal(c.permutation!.seed, 9);
});

test("wash: too few swaps skips the null model and says so", () => {
  const r = analyzeWash({ swaps: [swapEvent(1, BASE_SLOT, addr(1), "buy", 1n, SOL)], transfers: [], entities: ents });
  assert.equal(r.permutation, null);
  assert.ok(r.notes.some((n) => n.includes("trop peu")));
  assert.equal(analyzeWash({ swaps: [], transfers: [], entities: ents }).roundTripShare, null);
});

test("wash: the creator is NOT excluded from the volume judgement (they can trade against their own pool) and is reported apart", () => {
  const creator = addr("creator");
  const e = entityMap();
  e.set(creator, { kind: "creator", label: "créateur du token" });
  const swaps = [...organicTrading(6, 30)];
  let n = 970_000;
  for (let k = 0; k < 20; k++) {
    swaps.push(swapEvent(n++, BASE_SLOT + 5000 + k * 100, creator, "buy", 1_000_000n, SOL));
    swaps.push(swapEvent(n++, BASE_SLOT + 5050 + k * 100, creator, "sell", 1_000_000n, SOL));
  }
  const r = analyzeWash({ swaps, transfers: [], entities: e });
  assert.ok(r.roundTripWallets.includes(creator));
  assert.ok(r.creatorVolumeShare! > 0.3, `creator share ${r.creatorVolumeShare}`);
  assert.equal(r.excludedQuote, 0n);
  assert.equal(analyzeWash({ swaps, transfers: [], entities: ents }).creatorVolumeShare, null, "no creator known → no share");
});

test("cluster (hot launch): when everything co-occurs by default, groups are described but no hypothesis is written", () => {
  // 40 wallets, all buying in the same 3 slots with very similar non-round amounts, all selling together
  const swaps: SwapEvent[] = [];
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  for (let i = 0; i < 40; i++) {
    const w = addr(`hot${i}`);
    const q = 770_000_000n + BigInt(i % 5) * 2_000_000n;
    swaps.push(swapEvent(80_000 + i, BASE_SLOT + (i % 3), w, "buy", q * 1000n, q));
    swaps.push(swapEvent(81_000 + i, BASE_SLOT + 100 + (i % 2), w, "sell", q * 1000n, q));
    map[w] = [{ from: FUNDER, lamports: SOL, slot: 10 + i, n: 82_000 + i }];
  }
  const r = run(swaps, mapProvider({ ...map, [FUNDER]: [] }));
  assert.ok(r.cluster.groups.length > 0, "the co-occurrence is described");
  assert.ok(r.cluster.groups.every((g) => !g.hypothesisEligible), "…but it is what the launch does by default: no hypothesis");
  assert.ok(r.cluster.notes.some((n) => n.includes("pas d'hypothèse")));
  assert.equal(r.cluster.excess?.significant, false);
});

test("cluster: a bundle hidden among organic wallets is significant against the REST of the cohort; each group carries its p-value", () => {
  const b = bundle(8, { sellAfter: 100 });
  const o = organicLaunch(prng(11), 30);
  const prov = mapProvider({ ...b.map, [FUNDER]: [], ...Object.fromEntries(o.wallets.map((w, i) => [w, [{ from: addr(`h${i}`), lamports: SOL, slot: 5, n: 83_000 + i }]])) });
  const r = run([...o.swaps, ...b.swaps], prov);
  const g = r.cluster.groups.find((x) => x.strength === "multi_signal")!;
  assert.ok(g.pValue !== null && g.pValue < DEFAULT_CONFIG.alpha, `p=${g.pValue}`);
  assert.equal(g.hypothesisEligible, true);
  // permutations are configurable and the smoothed p-value cannot go below 1/(R+1)
  const r2 = run([...o.swaps, ...b.swaps], prov, { cfg: withConfig({ cluster: { permutations: 50 } }) });
  assert.ok(r2.cluster.groups[0]!.pValue! >= 1 / 51 - 1e-12);
});

test("cluster: a cohort too small for a null model never gets a hypothesis, and says so", () => {
  const b = bundle(5, { sellAfter: 100 });
  const r = run(b.swaps, mapProvider({ ...b.map, [FUNDER]: [] }));
  assert.equal(r.cluster.excess, null);
  const g = r.cluster.groups.find((x) => x.strength === "multi_signal");
  assert.ok(g && g.families.length >= 3 && g.pValue === null);
  assert.equal(g!.hypothesisEligible, false);
  assert.ok(r.cluster.notes.some((n) => n.includes("trop petite")));
});
