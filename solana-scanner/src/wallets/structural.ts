/**
 * Step 3 → Step 4 bridge. Pure.
 *
 * Step 3 looks at the largest holders and may find wallets that are
 * structurally related (strong relationship, deployment link, non-busy common
 * funder). Step 4 looks at buyers found in the token's transactions, so those
 * holders can be missing from its shortlist. This module picks, from facts
 * Step 3 already observed, at most `structural.maxWallets` extra wallets for
 * Step 4, and afterwards compares what Step 3 said with what Step 4 observed.
 *
 * Selection never uses size alone, a score, recency or UNKNOWN funding. It
 * gives no advantage in the analysis: selected wallets go through the same
 * history, flags, Quality and Confidence as buyers.
 */

import type { LinkType, RelatedWallets, WalletLink } from "../onchain/clusters.ts";
import type { OnchainData } from "../onchain/types.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import type { WalletFacts } from "./types.ts";

export type StructuralReason =
  | "deployment_funded"
  | "deployment_token_recipient"
  | "strong_same_funding_tx"
  | "strong_funded_by"
  | "strong_shared_tx"
  | "strong_same_funder_close"
  | "non_busy_common_funder";

export type SelectionSource = "buyer" | "structural" | "buyer_and_structural";

/**
 * A Step 3 edge as a stable reference. Wallet-pair links keep their addresses
 * in sorted order; anchored edges (deployment links, wallet → common funder)
 * have `a` = the wallet and `b` = the deployment wallet / funder.
 */
export interface Step3EdgeRef {
  type: LinkType | "deploymentFunded" | "deploymentTransfer" | "commonFunder";
  a: string;
  b: string;
  key: string | null;
  strength: "strong" | "medium" | "weak";
}

export interface StructuralCandidate {
  address: string;
  reasons: StructuralReason[];
  /** 1 deployment-linked · 2 strong group member · 3 non-busy common funder · 4 other strong edge. */
  priority: 1 | 2 | 3 | 4;
  /** Index in Step 3 `related.groups`, when the wallet is in one. */
  step3Group: number | null;
  /** Wallets in its relationship (group size, or funder recipients). */
  relatedCount: number;
  /** Combined % of supply of that relationship. */
  combinedPct: number;
  edges: Step3EdgeRef[];
}

export interface StructuralSelection {
  /** Every eligible wallet, in priority order. */
  candidates: StructuralCandidate[];
  /** Eligible wallets already in the buyer shortlist (no extra analysis). */
  deduplicated: StructuralCandidate[];
  /** Extra wallets to analyse (≤ maxWallets). */
  added: StructuralCandidate[];
  /** Eligible wallets left out by the cap. */
  skipped: StructuralCandidate[];
}

export interface Step3Facts {
  data: Pick<OnchainData, "wallets" | "creatorActivity" | "creator">;
  related: RelatedWallets | null;
}

const STRONG_REASON: Partial<Record<LinkType, StructuralReason>> = {
  sameTx: "strong_same_funding_tx",
  fundedBy: "strong_funded_by",
  sharedTx: "strong_shared_tx",
  sameFunderClose: "strong_same_funder_close",
};

const ANCHORED = new Set<Step3EdgeRef["type"]>(["deploymentFunded", "deploymentTransfer", "commonFunder"]);
const ref = (l: { type: Step3EdgeRef["type"]; a: string; b: string; key: string | null; strength: Step3EdgeRef["strength"] }): Step3EdgeRef => {
  const [a, b] = ANCHORED.has(l.type) || l.a < l.b ? [l.a, l.b] : [l.b, l.a];
  return { type: l.type, a, b, key: l.key, strength: l.strength };
};

/**
 * Eligible Step 3 wallets, ranked, capped. `isExcluded` removes technical
 * accounts; the deployment-associated wallet itself is analysed separately.
 */
export function selectStructuralWallets(
  step3: Step3Facts,
  o: { buyerPicks: string[]; isExcluded: (address: string) => boolean },
  c: WalletConfig = WALLET_CONFIG,
): StructuralSelection {
  const s = c.structural;
  // Sections may be missing on partial Step 3 results: missing = nothing to bridge.
  const creator = step3.data.creator?.status === "ok" ? step3.data.creator.value.address : null;
  const holders = step3.data.wallets?.status === "ok" ? step3.data.wallets.value : [];
  const pctOf = new Map(holders.map((h) => [h.address, h.pct]));
  const funderSigs = new Map<string, number | null>();
  for (const h of holders) if (h.funder) funderSigs.set(h.funder, h.funderSignatureCount ?? null);
  // Busy only when counted and at/above the threshold; an uncounted funder is UNKNOWN, never evidence.
  const knownNonBusy = (f: string) => {
    const n = funderSigs.get(f);
    return n !== undefined && n !== null && n < s.busyFunderSignatures;
  };
  const busy = (f: string | null) => {
    const n = f ? funderSigs.get(f) : undefined;
    return n !== undefined && n !== null && n >= s.busyFunderSignatures;
  };

  const byAddr = new Map<string, StructuralCandidate>();
  const add = (address: string, reason: StructuralReason, priority: StructuralCandidate["priority"], rel: { group: number | null; count: number; pct: number }, edge: Step3EdgeRef) => {
    if (address === creator || o.isExcluded(address)) return;
    const cur = byAddr.get(address);
    if (!cur) {
      byAddr.set(address, { address, reasons: [reason], priority, step3Group: rel.group, relatedCount: rel.count, combinedPct: rel.pct, edges: [edge] });
      return;
    }
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    if (!cur.edges.some((e) => e.type === edge.type && e.a === edge.a && e.b === edge.b)) cur.edges.push(edge);
    if (priority < cur.priority || (priority === cur.priority && rel.count > cur.relatedCount)) {
      cur.priority = priority;
      cur.relatedCount = rel.count;
      cur.combinedPct = rel.pct;
    }
    if (cur.step3Group === null) cur.step3Group = rel.group;
  };

  // 1. Deployment-linked: funded by the deployment wallet, or significant token transfer from it.
  if (creator) {
    const funded = holders.filter((h) => h.funder === creator);
    const pct = funded.reduce((t, h) => t + h.pct, 0);
    for (const h of funded) add(h.address, "deployment_funded", 1, { group: null, count: funded.length, pct }, ref({ type: "deploymentFunded", a: h.address, b: creator, key: creator, strength: "strong" }));
    if (step3.data.creatorActivity?.status === "ok") {
      for (const e of step3.data.creatorActivity.value.events) {
        if (e.kind !== "transfer" || -e.tokenDeltaPct < s.minDeploymentTransferPct) continue;
        for (const r of e.recipients) add(r, "deployment_token_recipient", 1, { group: null, count: e.recipients.length, pct: -e.tokenDeltaPct }, ref({ type: "deploymentTransfer", a: r, b: creator, key: e.signature, strength: "strong" }));
      }
    }
  }

  // Strong Step 3 links. A close-in-time funding from a busy funder is not used here.
  const strong = (l: WalletLink) => l.strength === "strong" && !(l.type === "sameFunderClose" && busy(l.key));
  const groups = step3.related?.groups ?? [];
  const groupOf = (a: string) => groups.findIndex((g) => g.members.some((m) => m.address === a));
  for (const l of (step3.related?.links ?? []).filter(strong)) {
    const reason = STRONG_REASON[l.type];
    if (!reason) continue;
    for (const w of [l.a, l.b]) {
      const gi = groupOf(w);
      const g = gi >= 0 ? groups[gi] : null;
      // 2. member of a relationship group with a verified strong edge; 4. any other strong edge.
      add(w, reason, g ? 2 : 4, g ? { group: gi, count: g.members.length, pct: g.share } : { group: null, count: 2, pct: (pctOf.get(l.a) ?? 0) + (pctOf.get(l.b) ?? 0) }, ref(l));
    }
  }

  // 3. Non-busy common funder shared by several analysed holders (busy or uncounted funders never qualify).
  const byFunder = new Map<string, string[]>();
  for (const h of holders) if (h.funder && h.funder !== creator) byFunder.set(h.funder, [...(byFunder.get(h.funder) ?? []), h.address]);
  for (const [funder, ws] of byFunder) {
    if (ws.length < s.minCommonFunderWallets || !knownNonBusy(funder)) continue;
    const pct = ws.reduce((t, w) => t + (pctOf.get(w) ?? 0), 0);
    for (const w of ws) {
      const gi = groupOf(w);
      add(w, "non_busy_common_funder", 3, { group: gi >= 0 ? gi : null, count: ws.length, pct }, ref({ type: "commonFunder", a: w, b: funder, key: funder, strength: "medium" }));
    }
  }

  const candidates = [...byAddr.values()].sort(
    (x, y) => x.priority - y.priority || y.relatedCount - x.relatedCount || y.combinedPct - x.combinedPct || (x.address < y.address ? -1 : x.address > y.address ? 1 : 0),
  );
  const picks = new Set(o.buyerPicks);
  const deduplicated = candidates.filter((x) => picks.has(x.address));
  const extra = candidates.filter((x) => !picks.has(x.address));
  const max = Math.max(0, s.maxWallets);
  return { candidates, deduplicated, added: extra.slice(0, max), skipped: extra.slice(max) };
}

export type ComparisonStatus = "confirmed" | "partially_confirmed" | "not_observed" | "unknown";

export interface Step3Step4Comparison {
  step3: Step3EdgeRef;
  status: ComparisonStatus;
  /** Step 4's own evidence (its links / funders), never copied from Step 3. */
  step4Evidence: string[];
  /** Why the status is what it is; not_observed is never a disproof. */
  note: string;
}

/**
 * Step 3 relationship evidence vs Step 4 observations, for edges whose wallets
 * Step 4 actually analysed. Descriptive only: never feeds a score, never adds a
 * link to Step 4. `not_observed` only when Step 4 had the data to see it.
 */
export function compareStep3Step4(
  edges: Step3EdgeRef[],
  step4: { links: WalletLink[]; facts: Map<string, WalletFacts>; clusterOf: Map<string, number> },
): Step3Step4Comparison[] {
  const seen = new Set<string>();
  const out: Step3Step4Comparison[] = [];
  for (const e of edges) {
    const id = `${e.type}|${e.a}|${e.b}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (ANCHORED.has(e.type)) {
      // Only the wallet (a) needs to be analysed; b is the deployment wallet or the funder.
      const f = step4.facts.get(e.a);
      if (!f) continue;
      if (e.type === "deploymentTransfer") {
        const t = f.history?.transfers.find((x) => x.direction === "in" && x.counterparties.includes(e.b));
        if (t) out.push({ step3: e, status: "confirmed", step4Evidence: [`transfert reçu du deployment-associated wallet (${t.signature})`], note: "transfert observé" });
        else if (f.trades !== null) out.push({ step3: e, status: "not_observed", step4Evidence: [], note: "historique Step 4 complet sans ce transfert ; pas une réfutation" });
        else out.push({ step3: e, status: "unknown", step4Evidence: [], note: "historique Step 4 incomplet" });
      } else if (f.funder === null) out.push({ step3: e, status: "unknown", step4Evidence: [], note: "financement UNKNOWN côté Step 4" });
      else if (f.funder === e.b) out.push({ step3: e, status: "confirmed", step4Evidence: [`financé par ${f.funder}${f.fundingSignature ? ` (${f.fundingSignature})` : ""}`], note: "même financeur observé" });
      else out.push({ step3: e, status: "not_observed", step4Evidence: [`financeur observé : ${f.funder}`], note: "financeur différent observé par Step 4 ; pas une réfutation" });
      continue;
    }
    const fa = step4.facts.get(e.a);
    const fb = step4.facts.get(e.b);
    if (!fa || !fb) continue;
    const direct = step4.links.filter((l) => (l.a === e.a && l.b === e.b) || (l.a === e.b && l.b === e.a));
    const evidence = direct.map((l) => `${l.type} (${l.strength}) : ${l.reason}`);
    if (direct.some((l) => l.type === e.type)) {
      out.push({ step3: e, status: "confirmed", step4Evidence: evidence, note: "même type de relation observé par Step 4" });
      continue;
    }
    const ca = step4.clusterOf.get(e.a);
    const sameCluster = ca !== undefined && ca === step4.clusterOf.get(e.b);
    if (direct.length || sameCluster) {
      out.push({ step3: e, status: "partially_confirmed", step4Evidence: direct.length ? evidence : ["même cluster Step 4 via d'autres wallets"], note: "relation observée par Step 4, preuve différente" });
      continue;
    }
    // Could Step 4 have seen it? Funding edges need both funders; shared transactions need both complete histories.
    const fundingEdge = e.type !== "sharedTx";
    const observable = e.type === "timing" ? fa.firstSeen !== null && fb.firstSeen !== null : fundingEdge ? fa.funder !== null && fb.funder !== null : fa.trades !== null && fb.trades !== null;
    out.push(
      observable
        ? { step3: e, status: "not_observed", step4Evidence: [], note: "données Step 4 suffisantes, relation non observée ; pas une réfutation" }
        : { step3: e, status: "unknown", step4Evidence: [], note: fundingEdge ? "financement UNKNOWN côté Step 4" : "historique Step 4 incomplet : transactions communes non vérifiables" },
    );
  }
  return out;
}

/** Every Step 3 edge the bridge may compare: all relationship links plus the deployment links of the candidates. */
export function step3Edges(step3: Step3Facts, selection: StructuralSelection): Step3EdgeRef[] {
  const links = (step3.related?.links ?? []).map((l) => ref(l));
  const extra = selection.candidates.flatMap((c) => c.edges.filter((e) => ANCHORED.has(e.type)));
  return [...links, ...extra];
}
