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
import { isRoundAmount } from "./behaviour.ts";
import { similar } from "./stats.ts";
import { runInference } from "./inference.ts";
import type { Inference } from "./inference.ts";

export { isRoundAmount };

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
  /**
   * A coordination hypothesis may be written: only when hypotheses are enabled by configuration (off by default),
   * the group is statistically significant after adjustment, uses a funding link, and shows ≥ 3 families including
   * one beyond funding/timing. Never "proof".
   */
  hypothesisEligible: boolean;
  /** Why no hypothesis is eligible, when that is a configuration or inference matter. */
  hypothesisBlockedBy: string | null;
  baseShare: number | null;
  /** Family-wise adjusted p-value (5D-1 inference); null when the group cannot be tested (see `inference`). */
  adjustedP: number | null;
  /** adjustedP < alpha, funding link used, inference status "ok". */
  significant: boolean;
  /** "ok": tested; "unknown": funding known for too few wallets; "behaviour_only": no funding link, untestable; "not_applicable". */
  inference: "ok" | "unknown" | "behaviour_only" | "not_applicable";
}

export interface ClusterReport {
  groups: CoordGroup[];
  /** Result of the group inference (status, coverage, method). Groups below carry its adjusted p-values. */
  inference: Inference;
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

  const inference = runInference({ cohort: args.cohort, swaps: args.swaps, funding: args.funding, cfg });
  /** The tested component that contains most of a group's wallets, if any. */
  const matchComponent = (wallets: readonly string[]) => {
    let best: Inference["components"][number] | null = null;
    let bestOverlap = 0;
    for (const comp of inference.components) {
      const overlap = wallets.filter((w) => comp.wallets.includes(w)).length;
      if (overlap > bestOverlap) {
        best = comp;
        bestOverlap = overlap;
      }
    }
    return bestOverlap >= 2 ? best : null;
  };
  const verdict = (wallets: readonly string[]): Pick<CoordGroup, "adjustedP" | "significant" | "inference"> => {
    if (inference.status !== "ok") return { adjustedP: null, significant: false, inference: inference.status };
    const comp = matchComponent(wallets);
    if (comp === null || comp.adjustedP === null) return { adjustedP: null, significant: false, inference: comp === null ? "unknown" : "behaviour_only" };
    return { adjustedP: comp.adjustedP, significant: comp.adjustedP < cfg.alpha, inference: "ok" };
  };
  const blocked = (fams: readonly Family[], v: { significant: boolean }): string | null => {
    if (!cfg.hypotheses.enabled) return "hypothèses automatiques désactivées par configuration";
    if (!v.significant) return "groupe non significatif ou non testable";
    if (fams.length < cfg.cluster.minFamiliesForHypothesis || !fams.some((f) => f !== "funding" && f !== "timing")) return "familles insuffisantes";
    return null;
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
    const v = verdict(wallets);
    const why = blocked(fams, v);
    groups.push({
      id: `g-${root.slice(0, 6)}`,
      wallets,
      families: fams,
      strength: "multi_signal",
      pairs: ps,
      anchors: [...new Set(ps.flatMap((p) => Object.values(p.anchors).flat() as string[]))].sort(),
      counterExplanations: [...new Set(fams.flatMap((f) => COUNTER_EXPLANATIONS[f]))],
      hypothesisEligible: why === null,
      hypothesisBlockedBy: why,
      ...v,
      baseShare: args.supplyRaw && args.supplyRaw > 0n ? Number((baseSum * 1_000_000n) / args.supplyRaw) / 1_000_000 : null,
    });
  }
  groups.sort((a, b) => b.wallets.length - a.wallets.length || (a.id < b.id ? -1 : 1));

  // weak, single-family groups worth listing: a discriminating shared funder
  for (const s of args.funding.shared) {
    if (!s.discriminating || s.wallets.length < Math.max(2, cfg.cluster.minGroupSize)) continue;
    if (groups.some((g) => s.wallets.every((w) => g.wallets.includes(w)))) continue;
    groups.push({ id: `f-${s.source.slice(0, 6)}-${s.hop}`, wallets: [...s.wallets].sort(), families: ["funding"], strength: "single_signal", pairs: [], anchors: [...s.signatures].sort(), counterExplanations: [...COUNTER_EXPLANATIONS.funding], hypothesisEligible: false, hypothesisBlockedBy: cfg.hypotheses.enabled ? "un seul signal" : "hypothèses automatiques désactivées par configuration", baseShare: null, adjustedP: null, significant: false, inference: "behaviour_only" });
  }
  if (args.funding.notTraced.length > 0 || args.funding.unavailable.length > 0) notes.push("la détection de financement porte sur les wallets tracés uniquement (voir couverture du financement)");
  if (inference.status !== "ok" && inference.reason) notes.push(`inférence sur les groupes: ${inference.status.toUpperCase()} — ${inference.reason}`);
  if (inference.status === "ok" && groups.some((g) => g.strength === "multi_signal" && g.inference === "behaviour_only")) notes.push("des groupes ne reposent que sur le comportement (slot, montant, sortie): similitude décrite, non testable, pas d'hypothèse");
  return { groups, inference, singleFamilyPairs, notes };
}

