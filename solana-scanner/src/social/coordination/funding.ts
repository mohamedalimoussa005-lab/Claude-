/**
 * Funding graph of a cohort: who sent the first SOL to each wallet, and who funded that funder (up to `maxHops`).
 *
 * Observed: the transfers themselves (signature, slot, amount).
 * Computed: groups of wallets that share an ancestor, with amounts and timing compared.
 * Never concluded: that a shared funder means a shared owner. Exchanges, bridges, routers, tip accounts and
 * high-activity wallets fund thousands of unrelated people; their groups are reported as non-discriminating.
 *
 * The history of each wallet is supplied by the caller (`FundingProvider`), so this module never reads a network.
 * A wallet whose history is missing or only partly read is reported as such, never skipped silently.
 */

import type { CoordinationConfig, Coverage, KnownEntity, SolTransfer } from "./model.ts";
import { DEFAULT_CONFIG } from "./model.ts";
import { similar } from "./stats.ts";

export interface WalletFundingHistory {
  wallet: string;
  /** Inbound SOL transfers to `wallet` that were read (any order). */
  inbound: readonly SolTransfer[];
  coverage: Coverage;
  /** Distinct recipients of this wallet's outbound transfers in the sample read, when measured. */
  sampledFanout?: number;
  /** True when the signature list hit the sampling cap (a very active wallet). */
  activityCapped?: boolean;
}

export type FundingProvider = (wallet: string) => WalletFundingHistory | null;

export interface FundingEdge {
  from: string;
  to: string;
  lamports: bigint;
  signature: string;
  slot: number;
  blockTime: number | null;
  /** 1 = direct funder of the cohort wallet. */
  hop: number;
}

export type TerminalReason = "neutral_entity" | "probable_service" | "max_hops" | "no_funding_found" | "history_unavailable" | "history_incomplete_no_funding";

export interface WalletFunding {
  wallet: string;
  chain: FundingEdge[];
  /** Where tracing stopped, and why. */
  terminal: { address: string; reason: TerminalReason; entity: KnownEntity | null };
  /** True when at least one history on the chain did not reach the oldest transaction: the "first" funding may not be the first. */
  partial: boolean;
  /**
   * What is known about this wallet's first-hop funding:
   *   known    a funder was observed (link observed, even if the history is partial: see `partial`), or a COMPLETE
   *            history holds none (no link in a covered history)
   *   unknown  missing history, or a partial history in which nothing was found: absence of a link is NOT evidence
   *            of absence. Deeper hops may still be missing (`partial`, terminal reason).
   */
  knowledge: "known" | "unknown";
}

export interface SharedSource {
  source: string;
  hop: number;
  wallets: string[];
  /** The source is itself a cohort wallet. */
  sourceInCohort: boolean;
  entity: KnownEntity | null;
  probableService: boolean;
  /** False for exchanges, services, routers, tips, high-activity wallets: sharing them proves nothing. */
  discriminating: boolean;
  /** Share of the traced cohort funded through this source. */
  cohortShare: number;
  /** All hop-1 amounts of the group are within the tolerance of the group's median. */
  similarAmounts: boolean;
  /** All fundings of the group happened within `burstSeconds`. */
  burst: boolean;
  /** The source is the token creator or one of the creator's own funders. */
  creatorLinked: boolean;
  /** At least one funding of the group is based on a partial history. */
  partial: boolean;
  signatures: string[];
}

/** A cohort wallet that received SOL from the token creator, or from an address that funded the creator. */
export interface CreatorLink {
  wallet: string;
  /** "creator" = the creator itself sent the SOL; "creator_funder" = an address that funded the creator did. */
  kind: "creator" | "creator_funder";
  source: string;
  lamports: bigint;
  signature: string;
  slot: number;
  /** True when this transfer is the wallet's first funding (otherwise a later transfer). */
  firstFunding: boolean;
}

export interface FundingReport {
  /** Addresses on the creator's own funding chain (creator first), as far as it was traced. */
  creatorChain: string[];
  creatorLinks: CreatorLink[];
  wallets: WalletFunding[];
  /** Number of traced wallets whose funding relations are known / unknown (see WalletFunding.knowledge). */
  knownCount: number;
  unknownCount: number;
  /** Cohort wallets beyond `maxWallets`: not traced. */
  notTraced: string[];
  /** Wallets for which no history could be obtained at all. */
  unavailable: string[];
  shared: SharedSource[];
  /** Cohort wallet A sent SOL to cohort wallet B at some hop (directly or as ancestor). */
  internalLinks: { from: string; to: string; hop: number; signature: string }[];
  notes: string[];
}

export interface FundingArgs {
  cohort: readonly string[];
  provider: FundingProvider;
  entities: ReadonlyMap<string, KnownEntity>;
  /** Token creator, when known: its funding chain is traced too and cohort wallets linked to it are reported. */
  creator?: string | null;
  cfg?: CoordinationConfig;
}

function firstFunding(h: WalletFundingHistory, min: bigint): SolTransfer | null {
  const eligible = h.inbound.filter((t) => t.lamports >= min && t.from !== h.wallet && t.to === h.wallet);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.slot - b.slot || (a.signature < b.signature ? -1 : 1));
  return eligible[0]!;
}

export function traceFunding(args: FundingArgs): FundingReport {
  const cfg = args.cfg ?? DEFAULT_CONFIG;
  const fcfg = cfg.funding;
  const notes: string[] = [];
  const cohort = [...new Set(args.cohort)];
  const traced = cohort.slice(0, fcfg.maxWallets);
  const notTraced = cohort.slice(fcfg.maxWallets);
  if (notTraced.length > 0) notes.push(`${notTraced.length} wallet(s) de la cohorte non remontés (plafond ${fcfg.maxWallets}, réglable)`);

  const memo = new Map<string, WalletFundingHistory | null>();
  const history = (w: string) => {
    if (!memo.has(w)) memo.set(w, args.provider(w));
    return memo.get(w)!;
  };
  const isService = (h: WalletFundingHistory | null) => h !== null && ((h.activityCapped ?? false) || (h.sampledFanout ?? 0) >= fcfg.serviceFanout);

  const wallets: WalletFunding[] = [];
  const unavailable: string[] = [];
  for (const w of traced) {
    const chain: FundingEdge[] = [];
    let cur = w;
    let partial = false;
    let terminal: WalletFunding["terminal"] | null = null;
    for (let hop = 1; hop <= fcfg.maxHops; hop++) {
      const h = history(cur);
      if (h === null) {
        terminal = { address: cur, reason: "history_unavailable", entity: null };
        if (hop === 1) unavailable.push(w);
        partial = true;
        break;
      }
      if (!h.coverage.signaturesComplete) partial = true;
      const ff = firstFunding(h, fcfg.minFundingLamports);
      if (ff === null) {
        terminal = { address: cur, reason: h.coverage.signaturesComplete ? "no_funding_found" : "history_incomplete_no_funding", entity: null };
        break;
      }
      chain.push({ from: ff.from, to: cur, lamports: ff.lamports, signature: ff.signature, slot: ff.slot, blockTime: ff.blockTime, hop });
      const ent0 = args.entities.get(ff.from) ?? null;
      const ent = ent0 !== null && ent0.kind === "creator" ? null : ent0; // the creator is a party, not a neutral service
      if (ent) {
        terminal = { address: ff.from, reason: "neutral_entity", entity: ent };
        break;
      }
      const fh = hop < fcfg.maxHops ? history(ff.from) : null;
      if (isService(fh)) {
        terminal = { address: ff.from, reason: "probable_service", entity: { kind: "service_probable", label: "wallet à très forte activité (heuristique)" } };
        break;
      }
      cur = ff.from;
      if (hop === fcfg.maxHops) terminal = { address: ff.from, reason: "max_hops", entity: null };
    }
    const term = terminal ?? { address: cur, reason: "max_hops" as const, entity: null };
    // hop-1 outcome decides: a funder was observed, or a COMPLETE history holds none. A missing or capped history with nothing found says nothing.
    const knowledge = chain.length > 0 || term.reason === "no_funding_found" ? ("known" as const) : ("unknown" as const);
    wallets.push({ wallet: w, chain, terminal: term, partial, knowledge });
  }

  // the creator's own funding chain (creator, its funder, ...), stopping at neutral entities and very active wallets
  const creatorChain: string[] = [];
  if (args.creator) {
    let cur = args.creator;
    creatorChain.push(cur);
    for (let hop = 1; hop <= fcfg.maxHops; hop++) {
      const h = history(cur);
      const ff = h === null ? null : firstFunding(h, fcfg.minFundingLamports);
      if (ff === null) break;
      const e = args.entities.get(ff.from);
      if (e && e.kind !== "creator") break;
      if (isService(history(ff.from))) break;
      creatorChain.push(ff.from);
      cur = ff.from;
    }
  }
  const creatorSources = new Set(creatorChain);
  if (args.creator) {
    const ch = history(args.creator);
    if (ch === null) notes.push("historique du créateur indisponible: ses financeurs ne sont pas connus");
    else if (!ch.coverage.signaturesComplete) notes.push("historique du créateur partiel (wallet très actif): son premier financement n'est pas établi");
  }
  const creatorLinks: CreatorLink[] = [];
  for (const w of traced) {
    const wf = wallets.find((x) => x.wallet === w)!;
    const firstSig = wf.chain[0]?.signature;
    const seen = new Set<string>();
    for (const t of history(w)?.inbound ?? []) {
      if (t.lamports < fcfg.minFundingLamports || !creatorSources.has(t.from) || t.from === w || seen.has(t.signature)) continue;
      seen.add(t.signature);
      creatorLinks.push({ wallet: w, kind: t.from === args.creator ? "creator" : "creator_funder", source: t.from, lamports: t.lamports, signature: t.signature, slot: t.slot, firstFunding: t.signature === firstSig });
    }
  }
  creatorLinks.sort((a, b) => a.slot - b.slot || (a.signature < b.signature ? -1 : 1));

  // shared ancestors, per hop
  const cohortSet = new Set(traced);
  const shared: SharedSource[] = [];
  const internalLinks: FundingReport["internalLinks"] = [];
  for (let hop = 1; hop <= fcfg.maxHops; hop++) {
    const bySource = new Map<string, { wallet: WalletFunding; edge: FundingEdge }[]>();
    for (const wf of wallets) {
      const e = wf.chain.find((c) => c.hop === hop);
      if (!e) continue;
      (bySource.get(e.from) ?? bySource.set(e.from, []).get(e.from)!).push({ wallet: wf, edge: e });
      if (cohortSet.has(e.from)) internalLinks.push({ from: e.from, to: wf.wallet, hop, signature: e.signature });
    }
    for (const [source, items] of bySource) {
      const ws = [...new Set(items.map((i) => i.wallet.wallet))];
      if (ws.length < cfg.cluster.minGroupSize) continue;
      const ent0 = args.entities.get(source) ?? null;
      const ent = ent0 !== null && ent0.kind === "creator" ? null : ent0;
      const terminalProbable = items.some((i) => i.wallet.terminal.address === source && i.wallet.terminal.reason === "probable_service");
      const sh = history(source);
      const probable = terminalProbable || isService(sh);
      const sorted = items.map((i) => i.edge.lamports).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const times = items.map((i) => i.edge.blockTime).filter((t): t is number => t !== null);
      shared.push({
        source,
        hop,
        wallets: ws,
        sourceInCohort: cohortSet.has(source),
        entity: ent,
        probableService: probable,
        discriminating: ent === null && !probable,
        cohortShare: ws.length / Math.max(1, traced.length),
        similarAmounts: sorted.every((a) => similar(a, median, fcfg.similarAmountTolerance)),
        burst: times.length === items.length && Math.max(...times) - Math.min(...times) <= fcfg.burstSeconds,
        creatorLinked: creatorSources.has(source),
        partial: items.some((i) => i.wallet.partial),
        signatures: items.map((i) => i.edge.signature),
      });
    }
  }
  shared.sort((a, b) => b.wallets.length - a.wallets.length || a.hop - b.hop || (a.source < b.source ? -1 : 1));
  const partials = wallets.filter((w) => w.partial).length;
  if (partials > 0) notes.push(`${partials} wallet(s) avec historique partiel: le premier financement observé n'est peut-être pas le premier`);
  if (unavailable.length > 0) notes.push(`${unavailable.length} wallet(s) sans historique disponible`);
  if (creatorLinks.length > 0) notes.push(`${new Set(creatorLinks.map((l) => l.wallet)).size} wallet(s) ont reçu du SOL du créateur ou d'un de ses financeurs (lien factuel, pas une preuve de contrôle)`);
  const knownCount = wallets.filter((w) => w.knowledge === "known").length;
  return { knownCount, unknownCount: wallets.length - knownCount, creatorChain, creatorLinks, wallets, notTraced, unavailable, shared, internalLinks, notes };
}
