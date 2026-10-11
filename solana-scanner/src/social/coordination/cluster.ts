/**
 * Groups of cohort wallets that show several independent kinds of similarity.
 *
 * Signal families (independent of each other by construction):
 *   funding   a discriminating ancestor is shared (not an exchange/service), or one wallet funded another
 *   timing    first buys at most `syncSlots` apart
 *   amount    first-buy amounts within the tolerance AND not both "round" amounts people pick by default
 *   exit      large sells (>= half of what the wallet bought) within `exitSyncSlots` of each other
 *   transfer  a direct, exactly paired transfer of the token between the two wallets
 *
 * Two wallets are joined only when they share at least two families. One family alone is reported separately as a
 * weak group. A group is never described as "controlled by one party": the strongest wording produced is a
 * hypothesis that stays compatible with common control, listing the ordinary explanations it cannot exclude.
 */

import type { CoordinationConfig, SwapEvent } from "./model.ts";
import { DEFAULT_CONFIG } from "./model.ts";
import type { CohortMember } from "./launch.ts";
import type { FundingReport } from "./funding.ts";
import type { TokenTransfer } from "./normalize.ts";
import { prng, similar } from "./stats.ts";

export type Family = "funding" | "timing" | "amount" | "exit" | "transfer";
export const FAMILIES: readonly Family[] = ["funding", "timing", "amount", "exit", "transfer"];

export const COUNTER_EXPLANATIONS: Readonly<Record<Family, readonly string[]>> = {
  funding: ["plateforme d'échange ou service de dépôt non étiqueté", "communauté ou amis qui se financent mutuellement", "bot public financé par son opérateur pour plusieurs clients"],
  timing: ["lancement très attendu: beaucoup d'acheteurs au premier slot", "bots de snipe publics ou bundles Jito", "annonce sociale simultanée"],
  amount: ["montants par défaut des interfaces de trading", "mêmes presets de taille chez plusieurs bots"],
  exit: ["événement externe visible de tous (alerte, baisse de prix)", "ordres de prise de profit automatiques identiques"],
  transfer: ["transfert entre amis ou entre portefeuilles d'une même personne sans lien avec la manipulation"],
};

export interface PairSignal {
  a: string;
  b: string;
  families: Family[];
  /** Transaction signatures that anchor each family (for the ledger). */
  anchors: Partial<Record<Family, string[]>>;
}

export interface CoordGroup {
  id: string;
  wallets: string[];
  families: Family[];
  strength: "single_signal" | "multi_signal";
  /** Pairs inside the group that carry at least `minFamiliesForMulti` families (empty for single-signal groups). */
  pairs: PairSignal[];
  anchors: string[];
  counterExplanations: string[];
  /** Enough independent families (and one beyond funding/timing) to write a coordination hypothesis. Never "proof". */
  hypothesisEligible: boolean;
  baseShare: number | null;
  /** P(the rest of the cohort, with families shuffled independently, yields a group at least this large); null if the rest is too small (< 6 wallets). */
  pValue: number | null;
}

/**
 * Null model for "how large a group do the families form by chance?". Each family's attribute (first-buy slot,
 * first-buy amount, large-exit slots, funding keys) is shuffled across wallets independently — marginals kept, the
 * association between families destroyed — and the largest connected set of wallets joined by pairs with at least
 * `minFamiliesForMulti` families is recorded. A hot launch where everything co-occurs by default has a large null.
 */
export interface PairExcess {
  observedMultiPairs: number;
  observedLargest: number;
  nullMeanMultiPairs: number;
  nullMeanLargest: number;
  nullP95Largest: number;
  permutations: number;
  /** P(null largest group >= observed largest group), add-one smoothed. */
  pValueLargest: number;
  significant: boolean;
  /** Sorted largest-group sizes of every permutation (lets each group get its own p-value). */
  nullSizes: number[];
}

export interface ClusterReport {
  groups: CoordGroup[];
  /** null when the cohort is too small (fewer than 6 wallets) for a null model. */
  excess: PairExcess | null;
  /** Pairs with exactly one family are summarised, not listed one by one. */
  singleFamilyPairs: Record<Family, number>;
  notes: string[];
}

export interface ClusterArgs {
  cohort: readonly CohortMember[];
  swaps: readonly SwapEvent[];
  funding: FundingReport;
  transfers: readonly TokenTransfer[];
  /** Total supply (raw) to express a group's holdings, or null. */
  supplyRaw: bigint | null;
  cfg?: CoordinationConfig;
}

/**
 * An amount that looks like a default pick: two significant digits ending in 0 or 5 (…0.5, 1, 1.5, 25, 100, 250…)
 * within 1 %. Works for any quote token because it only looks at the magnitude.
 */
export function isRoundAmount(amount: bigint): boolean {
  if (amount <= 0n) return false;
  const v = Number(amount);
  const scale = 10 ** Math.floor(Math.log10(v));
  const m = (v / scale) * 10; // 10..99.99
  const nearest = Math.round(m / 5) * 5;
  return Math.abs(m - nearest) <= 0.01 * m;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function clusterCohort(args: ClusterArgs): ClusterReport {
  const cfg = args.cfg ?? DEFAULT_CONFIG;
  const notes: string[] = [];
  const pairs = new Map<string, { a: string; b: string; fam: Map<Family, Set<string>> }>();
  const mark = (x: string, y: string, f: Family, anchors: string[]) => {
    if (x === y) return;
    const k = pairKey(x, y);
    let p = pairs.get(k);
    if (!p) pairs.set(k, (p = { a: x < y ? x : y, b: x < y ? y : x, fam: new Map() }));
    const set = p.fam.get(f) ?? new Set<string>();
    for (const a of anchors) set.add(a);
    p.fam.set(f, set);
  };
  const inCohort = new Set(args.cohort.map((m) => m.wallet));

  // funding: shared discriminating ancestor, or internal funding
  for (const s of args.funding.shared) {
    if (!s.discriminating) continue;
    const ws = s.wallets.filter((w) => inCohort.has(w));
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) mark(ws[i]!, ws[j]!, "funding", s.signatures);
  }
  for (const l of args.funding.internalLinks) if (inCohort.has(l.from) && inCohort.has(l.to)) mark(l.from, l.to, "funding", [l.signature]);

  // timing & amount
  const c = args.cohort;
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      const a = c[i]!;
      const b = c[j]!;
      if (Math.abs(a.firstBuySlot - b.firstBuySlot) <= cfg.launch.syncSlots) mark(a.wallet, b.wallet, "timing", [a.firstBuySignature, b.firstBuySignature]);
      if (similar(a.firstBuyQuote, b.firstBuyQuote, cfg.cluster.amountTolerance) && !(isRoundAmount(a.firstBuyQuote) && isRoundAmount(b.firstBuyQuote))) {
        mark(a.wallet, b.wallet, "amount", [a.firstBuySignature, b.firstBuySignature]);
      }
    }
  }

  // exits: large sells close in time
  const bought = new Map(c.map((m) => [m.wallet, m.boughtBase]));
  const exits = new Map<string, SwapEvent[]>();
  for (const s of args.swaps) {
    if (s.side !== "sell" || !inCohort.has(s.trader)) continue;
    const b = bought.get(s.trader) ?? 0n;
    if (b > 0n && s.baseAmount * 2n >= b) (exits.get(s.trader) ?? exits.set(s.trader, []).get(s.trader)!).push(s);
  }
  const exitWallets = [...exits.keys()].sort();
  for (let i = 0; i < exitWallets.length; i++) {
    for (let j = i + 1; j < exitWallets.length; j++) {
      for (const x of exits.get(exitWallets[i]!)!) {
        const y = exits.get(exitWallets[j]!)!.find((z) => Math.abs(z.slot - x.slot) <= cfg.cluster.exitSyncSlots);
        if (y) {
          mark(exitWallets[i]!, exitWallets[j]!, "exit", [x.signature, y.signature]);
          break;
        }
      }
    }
  }

  // direct transfers
  for (const t of args.transfers) if (inCohort.has(t.from) && inCohort.has(t.to)) mark(t.from, t.to, "transfer", [t.signature]);

  // union over pairs with >= minFamiliesForMulti families
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx < ry ? ry : rx, rx < ry ? rx : ry);
  };
  const strongPairs: PairSignal[] = [];
  const singleFamilyPairs = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
  for (const p of [...pairs.values()].sort((x, y) => (pairKey(x.a, x.b) < pairKey(y.a, y.b) ? -1 : 1))) {
    const fams = FAMILIES.filter((f) => p.fam.has(f));
    if (fams.length >= cfg.cluster.minFamiliesForMulti) {
      union(p.a, p.b);
      strongPairs.push({ a: p.a, b: p.b, families: fams, anchors: Object.fromEntries(fams.map((f) => [f, [...p.fam.get(f)!].sort()])) as PairSignal["anchors"] });
    } else if (fams.length === 1) singleFamilyPairs[fams[0]!]++;
  }

  const excess = pairExcess(args, cfg);
  /** Chance of a group this large arising from the REST of the cohort (the group's own wallets would inflate the base rates). */
  const groupP = (wallets: readonly string[]): number | null => {
    const bg = pairExcess(args, cfg, new Set(wallets));
    return bg === null ? null : (bg.nullSizes.filter((x) => x >= wallets.length).length + 1) / (bg.permutations + 1);
  };

  const byRoot = new Map<string, PairSignal[]>();
  for (const sp of strongPairs) (byRoot.get(find(sp.a)) ?? byRoot.set(find(sp.a), []).get(find(sp.a))!).push(sp);
  const baseOf = new Map(c.map((m) => [m.wallet, m.boughtBase]));
  const groups: CoordGroup[] = [];
  for (const [root, ps] of byRoot) {
    const wallets = [...new Set(ps.flatMap((p) => [p.a, p.b]))].sort();
    if (wallets.length < cfg.cluster.minGroupSize) continue;
    const fams = FAMILIES.filter((f) => ps.some((p) => p.families.includes(f)));
    const baseSum = wallets.reduce((a, w) => a + (baseOf.get(w) ?? 0n), 0n);
    const gp = groupP(wallets);
    groups.push({
      id: `g-${root.slice(0, 6)}`,
      wallets,
      families: fams,
      strength: "multi_signal",
      pairs: ps,
      anchors: [...new Set(ps.flatMap((p) => Object.values(p.anchors).flat() as string[]))].sort(),
      counterExplanations: [...new Set(fams.flatMap((f) => COUNTER_EXPLANATIONS[f]))],
      hypothesisEligible: fams.length >= cfg.cluster.minFamiliesForHypothesis && fams.some((f) => f !== "funding" && f !== "timing") && gp !== null && gp < cfg.alpha,
      pValue: gp,
      baseShare: args.supplyRaw && args.supplyRaw > 0n ? Number((baseSum * 1_000_000n) / args.supplyRaw) / 1_000_000 : null,
    });
  }
  groups.sort((a, b) => b.wallets.length - a.wallets.length || (a.id < b.id ? -1 : 1));

  // weak, single-family groups worth listing: a discriminating shared funder
  for (const s of args.funding.shared) {
    if (!s.discriminating || s.wallets.length < Math.max(2, cfg.cluster.minGroupSize)) continue;
    if (groups.some((g) => s.wallets.every((w) => g.wallets.includes(w)))) continue;
    groups.push({ id: `f-${s.source.slice(0, 6)}-${s.hop}`, wallets: [...s.wallets].sort(), families: ["funding"], strength: "single_signal", pairs: [], anchors: [...s.signatures].sort(), counterExplanations: [...COUNTER_EXPLANATIONS.funding], hypothesisEligible: false, baseShare: null, pValue: null });
  }
  if (args.funding.notTraced.length > 0 || args.funding.unavailable.length > 0) notes.push("la détection de financement porte sur les wallets tracés uniquement (voir couverture du financement)");
  if (excess === null && c.length > 0) notes.push("cohorte trop petite pour le modèle nul: aucune hypothèse de coordination n'est écrite");
  if (excess !== null && !excess.significant && groups.some((g) => g.strength === "multi_signal")) notes.push("les paires à signaux multiples ne dépassent pas ce que le hasard produit pour ce lancement: groupes décrits, pas d'hypothèse");
  return { groups, excess, singleFamilyPairs, notes };
}

/**
 * Permutation test for "families co-occur more than chance". Each wallet carries one attribute per family (first-buy
 * slot, first-buy amount, large-exit slots, funding keys). The observed number of wallet pairs sharing at least
 * `minFamiliesForMulti` of the four families is compared with the same count after shuffling each attribute across
 * wallets independently (marginals kept, associations destroyed). Transfers are left out: they are pairwise facts.
 */
function pairExcess(args: ClusterArgs, cfg: CoordinationConfig, drop?: ReadonlySet<string>): PairExcess | null {
  const c = drop ? args.cohort.filter((m) => !drop.has(m.wallet)) : args.cohort;
  const n = c.length;
  if (n < 6) return null;
  const idx = new Map(c.map((m, i) => [m.wallet, i]));
  const exits: number[][] = c.map(() => []);
  const bought = new Map(c.map((m) => [m.wallet, m.boughtBase]));
  for (const s of args.swaps) {
    const i = idx.get(s.trader);
    if (s.side === "sell" && i !== undefined) {
      const b = bought.get(s.trader) ?? 0n;
      if (b > 0n && s.baseAmount * 2n >= b) exits[i]!.push(s.slot);
    }
  }
  const keys: Set<string>[] = c.map(() => new Set<string>());
  for (const sh of args.funding.shared) {
    if (!sh.discriminating) continue;
    for (const w of sh.wallets) idx.has(w) && keys[idx.get(w)!]!.add(`src:${sh.source}`);
  }
  for (const l of args.funding.internalLinks) {
    if (idx.has(l.from) && idx.has(l.to)) {
      keys[idx.get(l.from)!]!.add(`anc:${l.from}`);
      keys[idx.get(l.to)!]!.add(`anc:${l.from}`);
    }
  }
  const slot = c.map((m) => m.firstBuySlot);
  const amt = c.map((m) => m.firstBuyQuote);
  const need = cfg.cluster.minFamiliesForMulti;

  const count = (pS: number[], pA: number[], pE: number[], pF: number[]): { pairs: number; largest: number } => {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
      return x;
    };
    let total = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let fam = 0;
        if (Math.abs(slot[pS[i]!]! - slot[pS[j]!]!) <= cfg.launch.syncSlots) fam++;
        const a = amt[pA[i]!]!;
        const b = amt[pA[j]!]!;
        if (similar(a, b, cfg.cluster.amountTolerance) && !(isRoundAmount(a) && isRoundAmount(b))) fam++;
        const ei = exits[pE[i]!]!;
        const ej = exits[pE[j]!]!;
        if (ei.length > 0 && ej.length > 0 && ei.some((x) => ej.some((y) => Math.abs(x - y) <= cfg.cluster.exitSyncSlots))) fam++;
        const ki = keys[pF[i]!]!;
        const kj = keys[pF[j]!]!;
        if (ki.size > 0 && kj.size > 0 && [...ki].some((k) => kj.has(k))) fam++;
        if (fam >= need) {
          total++;
          parent[find(i)] = find(j);
        }
      }
    }
    const sizes = new Map<number, number>();
    for (let i = 0; i < n; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
    return { pairs: total, largest: total === 0 ? 0 : Math.max(...sizes.values()) };
  };
  const id = Array.from({ length: n }, (_, i) => i);
  const observed = count(id, id, id, id);
  const rnd = prng(cfg.wash.seed + 31);
  const shuffled = (): number[] => {
    const a = [...id];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const sizes: number[] = [];
  let pairsSum = 0;
  for (let r = 0; r < cfg.cluster.permutations; r++) {
    const x = count(shuffled(), shuffled(), shuffled(), shuffled());
    sizes.push(x.largest);
    pairsSum += x.pairs;
  }
  sizes.sort((x, y) => x - y);
  const p = (sizes.filter((x) => x >= observed.largest).length + 1) / (cfg.cluster.permutations + 1);
  return {
    observedMultiPairs: observed.pairs,
    observedLargest: observed.largest,
    nullMeanMultiPairs: pairsSum / cfg.cluster.permutations,
    nullMeanLargest: sizes.reduce((a, b) => a + b, 0) / sizes.length,
    nullP95Largest: sizes[Math.min(sizes.length - 1, Math.floor(0.95 * sizes.length))]!,
    permutations: cfg.cluster.permutations,
    pValueLargest: p,
    significant: observed.largest > 0 && p < cfg.alpha,
    nullSizes: sizes,
  };
}
