/**
 * Group inference (Phase 5D-1).
 *
 * Question tested: "are wallets that share a discriminating funding source also behaviourally similar (same entry
 * time, similar size, synchronous exit) more often than if funding were unrelated to behaviour?"
 *
 * Null model: every wallet keeps its behaviour as ONE unit — first-buy slot, first-buy amount, exit slots, trade
 * counts — so arrival-time/amount/hold-time dependencies and per-wallet activity are preserved exactly. Only the
 * funding relations (which wallet holds which shared-source key) are permuted across wallets.
 *
 * Selection is repeated inside every permutation: the same detector (connected sets of wallets joined by pairs with
 * at least `minFamiliesForMulti` families) is applied to each permuted dataset, and the j-th largest observed group
 * is compared with the j-th largest group of each permutation, with step-down monotonicity. That controls the
 * family-wise error over all groups reported, including the choice of the groups themselves.
 *
 * What it can NOT do (documented limits):
 *  - behaviour-only similarity (same slot + similar amount + same exit time, no shared funding) is not testable:
 *    herd behaviour looks the same, so such groups carry no p-value;
 *  - only wallets whose funding is KNOWN (complete histories) enter; below the coverage floor the result is
 *    UNKNOWN, never "no link";
 *  - synthetic benchmarks only: no real-world false-positive rate is claimed.
 */

import type { CoordinationConfig, SwapEvent } from "./model.ts";
import type { CohortMember } from "./launch.ts";
import type { FundingReport } from "./funding.ts";
import { behaviourFamilies, largeExitSlots } from "./behaviour.ts";
import { prng } from "./stats.ts";

export interface InferenceComponent {
  wallets: string[];
  size: number;
  /** Step-down adjusted p-value (family-wise); null for behaviour-only groups, which cannot be tested. */
  adjustedP: number | null;
  /** At least one pair of the component is joined thanks to a shared funding key (otherwise the group is behaviour-only: untestable). */
  usesFunding: boolean;
}

export interface Inference {
  status: "ok" | "unknown" | "not_applicable";
  reason: string | null;
  method: string;
  tracedWallets: number;
  knownWallets: number;
  permutations: number;
  /** Observed groups among the known wallets, largest first (at least `minGroupSize` wallets). Only groups that use a funding link are tested. */
  components: InferenceComponent[];
  /** Whether any shared funding key exists among the known wallets (without one, nothing can be significant). */
  fundingRelationsPresent: boolean;
  /** The test was validated on synthetic benchmarks only (see docs/social-phase5d-statistics.md). */
  calibration: "synthetic_benchmark_only";
}

const METHOD = "permutation des relations de financement, comportement des wallets fixé, détection répétée à chaque tirage, p ajusté par statistique d'ordre (pas à pas)";

export interface InferenceArgs {
  cohort: readonly CohortMember[];
  swaps: readonly SwapEvent[];
  funding: FundingReport;
  cfg: CoordinationConfig;
}

export function runInference(args: InferenceArgs): Inference {
  const { cfg } = args;
  const traced = args.funding.wallets.length;
  const base = { method: METHOD, tracedWallets: traced, permutations: cfg.cluster.permutations, calibration: "synthetic_benchmark_only" as const };
  const known = new Set(args.funding.wallets.filter((w) => w.knowledge === "known").map((w) => w.wallet));
  const U = args.cohort.filter((m) => known.has(m.wallet));
  const empty = (status: Inference["status"], reason: string): Inference => ({ ...base, status, reason, knownWallets: U.length, components: [], fundingRelationsPresent: false });
  if (traced === 0) return empty("not_applicable", "aucun wallet de la cohorte n'a été remonté");
  if (1 / (cfg.cluster.permutations + 1) >= cfg.alpha) {
    return empty("unknown", `${cfg.cluster.permutations} permutations ne permettent pas d'atteindre le niveau alpha=${cfg.alpha} (p minimal ${(1 / (cfg.cluster.permutations + 1)).toFixed(4)}): augmenter les permutations ou relever alpha`);
  }
  if (U.length < cfg.inference.minKnownWallets || U.length / traced < cfg.inference.minKnownShare) {
    return empty("unknown", `financement connu pour ${U.length} wallet(s) sur ${traced} (seuil: ${cfg.inference.minKnownWallets} wallets et ${Math.round(cfg.inference.minKnownShare * 100)} %): l'absence de lien n'est pas établie`);
  }
  const n = U.length;
  const idx = new Map(U.map((m, i) => [m.wallet, i]));
  const exits = largeExitSlots(U, args.swaps);
  const need = cfg.cluster.minFamiliesForMulti;

  // behaviour families per pair (fixed under the null)
  const beh = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) beh[i]![j] = beh[j]![i] = behaviourFamilies(U[i]!, U[j]!, exits, cfg).length;

  // funding keys per wallet (permuted under the null)
  const keys: string[][] = U.map(() => []);
  for (const sh of args.funding.shared) {
    if (!sh.discriminating) continue;
    for (const w of sh.wallets) if (idx.has(w)) keys[idx.get(w)!]!.push(`src:${sh.source}`);
  }
  for (const l of args.funding.internalLinks) {
    if (idx.has(l.from) && idx.has(l.to)) {
      keys[idx.get(l.from)!]!.push(`anc:${l.from}`);
      keys[idx.get(l.to)!]!.push(`anc:${l.from}`);
    }
  }
  const fundingRelationsPresent = keys.some((k) => k.length > 0);

  /** Groups of wallets joined by ≥ `need` families. `funded` groups contain two wallets that share a funding key. */
  const detect = (assign: number[]): { groups: { members: number[]; funded: boolean; fundedCount: number }[]; fundedSizes: number[] } => {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
      return x;
    };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (beh[i]![j]! >= need) parent[find(i)] = find(j);
    const byKey = new Map<string, number[]>();
    if (fundingRelationsPresent) {
      for (let pos = 0; pos < n; pos++) for (const k of keys[assign[pos]!]!) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(pos);
      // a shared funding key adds the funding family to the pair: it can complete a pair that behaviour alone leaves one family short
      for (const members of byKey.values()) {
        for (let a = 0; a < members.length; a++) {
          for (let b = a + 1; b < members.length; b++) {
            const i = members[a]!;
            const j = members[b]!;
            if (beh[i]![j]! + 1 >= need) parent[find(i)] = find(j);
          }
        }
      }
    }
    // funding concentration of a group = number of its wallets that share a funding key with another wallet of the SAME group.
    // (The statistic counts wallets, not "at least one pair": a pair is easy to obtain by chance, eight wallets are not.)
    const fundedWallets = new Map<number, Set<number>>();
    for (const members of byKey.values()) {
      const byRoot = new Map<number, number[]>();
      for (const m of members) (byRoot.get(find(m)) ?? byRoot.set(find(m), []).get(find(m))!).push(m);
      for (const [root, ms] of byRoot) if (ms.length >= 2) { const set = fundedWallets.get(root) ?? new Set<number>(); ms.forEach((m) => set.add(m)); fundedWallets.set(root, set); }
    }
    const comp = new Map<number, number[]>();
    for (let i = 0; i < n; i++) (comp.get(find(i)) ?? comp.set(find(i), []).get(find(i))!).push(i);
    const groups = [...comp.entries()].filter(([, m]) => m.length >= cfg.cluster.minGroupSize).map(([root, members]) => ({ members, funded: (fundedWallets.get(root)?.size ?? 0) >= 2, fundedCount: fundedWallets.get(root)?.size ?? 0 }));
    groups.sort((x, y) => y.fundedCount - x.fundedCount || y.members.length - x.members.length);
    return { groups, fundedSizes: groups.filter((g) => g.funded).map((g) => g.fundedCount) };
  };

  const identity = Array.from({ length: n }, (_, i) => i);
  const observed = detect(identity);
  const fundedObserved = observed.groups.filter((g) => g.funded);
  const rnd = prng(cfg.seed + 101);
  const R = cfg.cluster.permutations;
  const exceed = new Array<number>(fundedObserved.length).fill(0);
  if (fundedObserved.length > 0) {
    for (let r = 0; r < R; r++) {
      const perm = [...identity];
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [perm[i], perm[j]] = [perm[j]!, perm[i]!];
      }
      const s = detect(perm).fundedSizes;
      for (let j = 0; j < fundedObserved.length; j++) if ((s[j] ?? 0) >= fundedObserved[j]!.fundedCount) exceed[j]!++;
    }
  }
  let prev = 0;
  let k = 0;
  const components: InferenceComponent[] = observed.groups.map((g) => {
    const wallets = g.members.map((i) => U[i]!.wallet).sort();
    if (!g.funded) return { wallets, size: g.members.length, adjustedP: null, usesFunding: false };
    prev = Math.max(prev, (1 + exceed[k++]!) / (R + 1)); // step-down: adjusted p never decreases with rank
    return { wallets, size: g.members.length, adjustedP: prev, usesFunding: true };
  });
  return { ...base, status: "ok", reason: null, knownWallets: n, components, fundingRelationsPresent };
}
