/**
 * Phase 5D-0 benchmark: labelled, seeded, network-free scenarios for the coordination engine.
 *
 * IMPORTANT: everything here is SYNTHETIC or semi-synthetic. It measures how the statistical procedure behaves when we
 * know the truth by construction (false-positive rate, power, calibration, sensitivity, robustness). It says nothing
 * about the real-world rate of manipulation, and it does not validate any claim about a real token.
 */

import { analyzeLaunch, analyzeWash, clusterCohort, entityMap, traceFunding, withConfig, DEFAULT_CONFIG } from "../../src/social/coordination/index.ts";
import type { ClusterReport, CoordinationConfig, FundingProvider, KnownEntity, LaunchReport, SwapEvent, WalletFundingHistory, WashReport, FundingReport } from "../../src/social/coordination/index.ts";
import { BASE_SLOT, MINT, SOL, addr, cov, prng, sig, swapEvent } from "./coordination.ts";

export interface Scenario {
  name: string;
  swaps: SwapEvent[];
  /** wallet → first funding. Wallets absent from the map have no funding in a COMPLETE history. */
  fund: Record<string, { from: string; lamports: bigint; slot: number }>;
  wallets: string[];
  /** Wallets that were planted as a coordinated group (empty for null regimes). */
  planted: string[];
  entities: Record<string, KnownEntity>;
  /** Funders whose history is capped (very active wallets: probable services). */
  capped: Set<string>;
}

export interface Pipeline {
  launch: LaunchReport;
  funding: FundingReport;
  cluster: ClusterReport;
  wash: WashReport;
}

const hashOf = (w: string): number => [...w].reduce((a, c) => (a * 33 + c.charCodeAt(0)) % 1_000_003, 7);
/** Provider for a scenario; `degrade` turns a fraction of wallets into "partial history, nothing found". */
export function providerOf(sc: Scenario, degraded: ReadonlySet<string> = new Set()): FundingProvider {
  return (wallet) => {
    const f = sc.fund[wallet];
    const isWallet = sc.wallets.includes(wallet);
    if (degraded.has(wallet)) return { wallet, inbound: [], coverage: cov({ signaturesComplete: false }) } as WalletFundingHistory;
    const inbound = f ? [{ signature: sig(7_000_000 + hashOf(wallet)), slot: f.slot, blockTime: 1_791_000_000 + f.slot, from: f.from, to: wallet, lamports: f.lamports }] : [];
    // funders and unrelated addresses: complete, empty histories (the funder of a funder is unknown, which is fine)
    return { wallet, inbound: isWallet ? inbound : [], coverage: cov(), activityCapped: sc.capped.has(wallet) };
  };
}

export function runPipeline(sc: Scenario, over: Parameters<typeof withConfig>[0] = {}, degraded: ReadonlySet<string> = new Set()): Pipeline {
  const cfg: CoordinationConfig = withConfig(over);
  const entities = entityMap(sc.entities);
  const launch = analyzeLaunch({ mint: MINT, swaps: sc.swaps, creator: null, entities, supplyRaw: 10n ** 15n, coverage: cov(), cfg });
  const funding = traceFunding({ cohort: launch.cohort.map((m) => m.wallet), provider: providerOf(sc, degraded), entities, cfg });
  const cluster = clusterCohort({ cohort: launch.cohort, swaps: sc.swaps, funding, transfers: [], supplyRaw: 10n ** 15n, cfg });
  const wash = analyzeWash({ swaps: sc.swaps, transfers: [], entities, cfg });
  return { launch, funding, cluster, wash };
}

// ------------------------------------------------------------------------------------------------ generators

const NSTART = 100_000;
let swapN = NSTART;
const ev = (slot: number, w: string, side: "buy" | "sell", q: bigint, ratio = 1000n) => swapEvent(swapN++, slot, w, side, q * ratio, q);

interface OrganicOpts {
  n?: number;
  /** Mean of the exponential arrival offset in slots: small = hot launch. */
  mean?: number;
  /** Share of wallets that happen to share a funder with 1–3 others (friends, aggregators), independent of behaviour. */
  incidental?: number;
  /** Amounts follow the arrival phase (bonding-curve tiers), holds depend on phase, exits are event-driven. */
  correlated?: boolean;
  prefix?: string;
}

/** Organic market: no coordination by construction. Funding is independent of behaviour (a few incidental shared funders). */
export function organic(seed: number, o: OrganicOpts = {}): Scenario {
  swapN = NSTART + (seed % 1000) * 1000; // signatures (the tie-break inside a slot) depend on the seed only: runs are reproducible
  const rng = prng(seed);
  const n = o.n ?? 40;
  const mean = o.mean ?? 12;
  const pre = o.prefix ?? `org${seed}`;
  const swaps: SwapEvent[] = [];
  const wallets: string[] = [];
  const fund: Scenario["fund"] = {};
  const events = [BASE_SLOT + 60 + Math.floor(rng() * 10), BASE_SLOT + 110 + Math.floor(rng() * 10), BASE_SLOT + 140];
  for (let i = 0; i < n; i++) {
    const w = addr(`${pre}-${i}`);
    wallets.push(w);
    const off = Math.floor(-Math.log(1 - rng()) * mean);
    const phase = Math.floor(off / 10);
    const q = o.correlated ? BigInt(Math.floor(0.2e9 * (1 + phase * 0.35) * (0.97 + 0.06 * rng()))) : BigInt(Math.floor(Math.exp(Math.log(0.05e9) + rng() * Math.log(100))));
    swaps.push(ev(BASE_SLOT + off, w, "buy", q));
    if (rng() < 0.7) {
      const exitSlot = o.correlated ? events[Math.floor(rng() * events.length)]! + Math.floor(rng() * 3) : BASE_SLOT + off + 20 + Math.floor(rng() * 80);
      swaps.push(ev(Math.max(exitSlot, BASE_SLOT + off + 1), w, "sell", (q * BigInt(80 + Math.floor(rng() * 60))) / 100n));
    }
  }
  // funding: own funder, except incidental groups
  const shared: string[][] = [];
  const pool = wallets.filter(() => rng() < (o.incidental ?? 0.15));
  for (let i = 0; i < pool.length; ) {
    const size = 2 + Math.floor(rng() * 2);
    shared.push(pool.slice(i, i + size));
    i += size;
  }
  const inShared = new Set(shared.flat());
  shared.forEach((g, gi) => g.forEach((w, j) => (fund[w] = { from: addr(`${pre}-shared-${gi}`), lamports: BigInt(Math.floor(5e8 + rng() * 4e9)), slot: 1000 + Math.floor(rng() * 90_000) + j })));
  wallets.forEach((w, i) => {
    if (!inShared.has(w)) fund[w] = { from: addr(`${pre}-own-${i}`), lamports: BigInt(Math.floor(5e8 + rng() * 4e9)), slot: 1000 + Math.floor(rng() * 90_000) };
  });
  return { name: `organic${o.correlated ? "-correlated" : ""}-${mean}`, swaps, fund, wallets, planted: [], entities: {}, capped: new Set() };
}

/** Copy-trading: followers enter right after a leader with a fixed ratio of its size and mirror its exit. Funding independent. */
export function copyTrading(seed: number, followers = 14): Scenario {
  const sc = organic(seed, { n: 25, mean: 30, prefix: `ct${seed}` });
  const rng = prng(seed * 7 + 1);
  const leader = addr(`ct${seed}-leader`);
  const leaderSlot = BASE_SLOT + 40;
  const leaderQ = 4n * SOL + BigInt(Math.floor(rng() * 1e8));
  const swaps = [...sc.swaps, ev(leaderSlot, leader, "buy", leaderQ), ev(leaderSlot + 90, leader, "sell", (leaderQ * 13n) / 10n)];
  const wallets = [...sc.wallets, leader];
  const fund = { ...sc.fund, [leader]: { from: addr(`ct${seed}-leader-src`), lamports: 9n * SOL, slot: 500 } };
  const capped = new Set<string>();
  const entities: Scenario["entities"] = {};
  const svc = addr(`ct${seed}-copy-service`);
  entities[svc] = { kind: "bot", label: "service de copy-trading" };
  const busy = addr(`ct${seed}-busy-funder`);
  capped.add(busy);
  for (let i = 0; i < followers; i++) {
    const w = addr(`ct${seed}-f${i}`);
    wallets.push(w);
    const q = (leaderQ * 777n) / 10_000n + BigInt(i % 2 === 0 ? 0 : Math.floor(rng() * 4e6)); // fixed non-round ratio, half exact
    swaps.push(ev(leaderSlot + 1 + Math.floor(rng() * 3), w, "buy", q));
    swaps.push(ev(leaderSlot + 91 + Math.floor(rng() * 3), w, "sell", (q * 13n) / 10n));
    fund[w] = { from: i < 4 ? svc : i < 8 ? busy : addr(`ct${seed}-fsrc${i}`), lamports: BigInt(Math.floor(1e9 + rng() * 3e9)), slot: 2000 + i * 13 };
  }
  return { name: "copy-trading", swaps, fund, wallets, planted: [], entities, capped };
}

/** Market making / arbitrage: a few wallets repeat balanced round trips at regular intervals. Funded independently. */
export function marketMaking(seed: number): Scenario {
  const sc = organic(seed, { n: 30, mean: 30, prefix: `mm${seed}` });
  const swaps = [...sc.swaps];
  const wallets = [...sc.wallets];
  const fund = { ...sc.fund };
  const rng = prng(seed * 11 + 3);
  for (let m = 0; m < 3; m++) {
    const w = addr(`mm${seed}-maker${m}`);
    wallets.push(w);
    fund[w] = { from: addr(`mm${seed}-msrc${m}`), lamports: 40n * SOL, slot: 300 + m };
    for (let k = 0; k < 20; k++) {
      const slot = BASE_SLOT + 5 + k * 6 + m * 2 + Math.floor(rng() * 2);
      const q = SOL + BigInt(Math.floor(rng() * 5e7));
      swaps.push(ev(slot, w, "buy", q));
      swaps.push(ev(slot + 3, w, "sell", (q * 9995n) / 10_000n));
    }
  }
  const bot = addr(`mm${seed}-arb`);
  const entities: Scenario["entities"] = { [bot]: { kind: "bot", label: "bot d'arbitrage" } };
  for (let k = 0; k < 30; k++) {
    swaps.push(ev(BASE_SLOT + 4 + k * 3, bot, "buy", 2n * SOL));
    swaps.push(ev(BASE_SLOT + 4 + k * 3, bot, "sell", (2n * SOL * 9990n) / 10_000n));
  }
  return { name: "market-making+arbitrage", swaps, fund, wallets, planted: [], entities, capped: new Set() };
}

/**
 * CONFOUNDER, not a null: three friend groups / communities, each funded by its founder and buying around the same
 * time with similar tickets. Funding really is associated with behaviour here, so the test (correctly) flags it:
 * what it detects is association, never intent. Reported separately from the false-positive rate.
 */
export function community(seed: number, groups = 3, size = 6): Scenario {
  const sc = organic(seed, { n: 25, mean: 35, prefix: `cm${seed}` });
  const rng = prng(seed * 17 + 9);
  const swaps = [...sc.swaps];
  const wallets = [...sc.wallets];
  const fund = { ...sc.fund };
  for (let g = 0; g < groups; g++) {
    const founder = addr(`cm${seed}-founder${g}`);
    const slot0 = BASE_SLOT + 10 + g * 45;
    const q0 = BigInt(Math.floor(0.3e9 + rng() * 1.5e9));
    for (let i = 0; i < size; i++) {
      const w = addr(`cm${seed}-g${g}-${i}`);
      wallets.push(w);
      swaps.push(ev(slot0 + Math.floor(rng() * 2), w, "buy", q0 + BigInt(Math.floor(rng() * 0.02 * Number(q0)))));
      swaps.push(ev(BASE_SLOT + 140 + g + Math.floor(rng() * 2), w, "sell", (q0 * 11n) / 10n));
      fund[w] = { from: founder, lamports: BigInt(Math.floor(1e9 + rng() * 2e9)), slot: 4000 + g * 100 + i };
    }
  }
  return { name: "community (confounder)", swaps, fund, wallets, planted: [], entities: sc.entities, capped: sc.capped };
}

export type PlantFamilies = { funding: boolean; timing: boolean; amount: boolean; exit: boolean };
export const PLANTS: Record<string, PlantFamilies> = {
  "F+T+A+E": { funding: true, timing: true, amount: true, exit: true },
  "F+T+A": { funding: true, timing: true, amount: true, exit: false },
  "F+T": { funding: true, timing: true, amount: false, exit: false },
  "F+A+E": { funding: true, timing: false, amount: true, exit: true },
  "T+A+E (no funding)": { funding: false, timing: true, amount: true, exit: true },
};

/** Controlled synthetic coordination: k wallets planted with the chosen families on top of a spread-out organic market. */
export function planted(seed: number, k: number, fam: PlantFamilies, base?: Scenario): Scenario {
  const sc = base ?? organic(seed, { n: 30, mean: 35, prefix: `pl${seed}` });
  const rng = prng(seed * 13 + 5);
  const swaps = [...sc.swaps];
  const wallets = [...sc.wallets];
  const fund = { ...sc.fund };
  const group: string[] = [];
  const baseSlot = BASE_SLOT + 55 + Math.floor(rng() * 20);
  const baseQ = BigInt(Math.floor(0.7e9 + rng() * 0.2e9)) / 1_000_000n * 1_000_000n + 123_456n; // non-round
  const funder = addr(`pl${seed}-operator`);
  for (let i = 0; i < k; i++) {
    const w = addr(`pl${seed}-g${i}`);
    group.push(w);
    wallets.push(w);
    const slot = fam.timing ? baseSlot + Math.floor(rng() * 2) : BASE_SLOT + Math.floor(rng() * 140);
    const q = fam.amount ? baseQ + BigInt(Math.floor(rng() * 0.02 * Number(baseQ))) : BigInt(Math.floor(Math.exp(Math.log(0.05e9) + rng() * Math.log(100))));
    swaps.push(ev(slot, w, "buy", q));
    const exitSlot = fam.exit ? BASE_SLOT + 150 + Math.floor(rng() * 2) : slot + 20 + Math.floor(rng() * 90);
    swaps.push(ev(exitSlot, w, "sell", (q * 12n) / 10n));
    fund[w] = { from: fam.funding ? funder : addr(`pl${seed}-gsrc${i}`), lamports: fam.funding ? 2n * SOL + BigInt(i) * 10_000n : BigInt(Math.floor(5e8 + rng() * 4e9)), slot: fam.funding ? 3000 + i : 1000 + Math.floor(rng() * 90_000) };
  }
  return { name: `planted k=${k}`, swaps, fund, wallets, planted: group, entities: sc.entities, capped: sc.capped };
}

// ------------------------------------------------------------------------------------------------ measures

export interface RegimeResult {
  launches: number;
  /** Launches where the group inference ran (status ok). */
  inferred: number;
  /** Launches with at least one significant group (family-wise false positive in null regimes, detection in planted ones). */
  flagged: number;
  /** Launches where the planted wallets (≥ 60 % of them) sit in one significant group. */
  detectedPlanted: number;
  /** Minimum adjusted p per launch (1 when nothing was tested): the calibration sample. */
  minP: number[];
  /** Launches with a hypothesis eligible (must be 0 while hypotheses are off). */
  hypotheses: number;
  groupsReported: number;
  unknown: number;
}

export function measure(scenarios: Iterable<Scenario>, over: Parameters<typeof withConfig>[0] = {}, degradeFraction = 0): RegimeResult {
  const res: RegimeResult = { launches: 0, inferred: 0, flagged: 0, detectedPlanted: 0, minP: [], hypotheses: 0, groupsReported: 0, unknown: 0 };
  let i = 0;
  for (const sc of scenarios) {
    const rng = prng(9000 + i++);
    const degraded = new Set(sc.wallets.filter(() => rng() < degradeFraction));
    const r = runPipeline(sc, over, degraded);
    res.launches++;
    if (r.cluster.inference.status === "ok") res.inferred++;
    else res.unknown++;
    res.groupsReported += r.cluster.groups.length;
    const sig = r.cluster.groups.filter((g) => g.significant);
    if (sig.length > 0) res.flagged++;
    if (r.cluster.groups.some((g) => g.hypothesisEligible)) res.hypotheses++;
    const ps = r.cluster.groups.map((g) => g.adjustedP).filter((p): p is number => p !== null);
    res.minP.push(ps.length ? Math.min(...ps) : 1);
    if (sc.planted.length > 0 && sig.some((g) => sc.planted.filter((w) => g.wallets.includes(w)).length >= Math.ceil(0.6 * sc.planted.length))) res.detectedPlanted++;
  }
  return res;
}

export const rate = (x: number, n: number): number => (n === 0 ? 0 : x / n);
export const seeds = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);
export { DEFAULT_CONFIG };

// ------------------------------------------------------------------------------------------------ semi-real

import { analyzeCoordination } from "../../src/social/coordination/index.ts";
import { inputOf, loadCapture } from "../fixtures/social/coordination/load.ts";
import type { TokenKey } from "../fixtures/social/coordination/load.ts";

/**
 * Real swaps (launch behaviour of a captured token) with SYNTHETIC funding. `mode`:
 *   "null"     funding drawn independently of behaviour (a few incidental shared funders): the null hypothesis holds by construction
 *   "cluster"  the wallets whose labels start with one of `prefixes` get a common funder (funding planted on a real behavioural cluster)
 */
export function semiReal(key: TokenKey, seed: number, mode: "null" | "cluster", prefixes: readonly string[] = []): Scenario {
  const c = loadCapture(key);
  const r = analyzeCoordination(inputOf(c, { provider: () => null }));
  const rng = prng(seed * 31 + 7);
  const wallets = r.launch.cohort.map((m) => m.wallet);
  const fund: Scenario["fund"] = {};
  const operator = addr(`semi-${key}-${seed}-operator`);
  const group = wallets.filter((w) => prefixes.some((p) => w.startsWith(p)));
  const incidental = wallets.filter((w) => !group.includes(w) && rng() < 0.15);
  const sharedOf = new Map<string, string>();
  for (let i = 0; i < incidental.length; i++) sharedOf.set(incidental[i]!, addr(`semi-${key}-${seed}-sh-${Math.floor(i / 3)}`));
  wallets.forEach((w, i) => {
    const planted = mode === "cluster" && group.includes(w);
    fund[w] = { from: planted ? operator : sharedOf.get(w) ?? addr(`semi-${key}-${seed}-own-${i}`), lamports: planted ? 2n * SOL : BigInt(Math.floor(5e8 + rng() * 4e9)), slot: 1000 + Math.floor(rng() * 90_000) };
  });
  return { name: `semi-real ${key} ${mode}`, swaps: r.swaps, fund, wallets, planted: mode === "cluster" ? group : [], entities: {}, capped: new Set() };
}
