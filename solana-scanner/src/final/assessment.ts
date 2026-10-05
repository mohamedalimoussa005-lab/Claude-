/**
 * Final Decision Engine V1. Rules and gates over facts the three engines
 * already computed — no new score, weight or threshold, no data call.
 *
 *   DEX (Step 2)          interest / timing: the base decision (its labels, unchanged)
 *   On-chain (Step 3)     structural safety: confirmed facts only, never the raw Risk score
 *                         (which also carries points for UNKNOWN data)
 *   Wallet Intel (Step 4) confirmation / warnings: never raises the decision
 *   Data Confidence       uncertainty: shown, never changes the decision
 *
 * Priority: confirmed hard blocker → AVOID; else confirmed structural caution
 * → CAUTION (when the base is MOMENTUM, WATCH or DEX HIGH RISK); else the base.
 * UNKNOWN / unavailable data never blocks and never becomes a negative reason.
 * The labels describe what the scanner observed, never a buy or sell call.
 */

import type { RedFlagKey } from "../onchain/analyze.ts";
import { ONCHAIN_CONFIG } from "../onchain/config.ts";
import type { OnchainConfig } from "../onchain/config.ts";
import type { LinkType, WalletLink } from "../onchain/clusters.ts";
import type { OnchainResult } from "../onchain/service.ts";
import type { Label, PairScore } from "../scoring/score.ts";
import { WALLET_CONFIG } from "../wallets/config.ts";
import type { WalletIntel } from "../wallets/intel.ts";
import type { DataConfidence } from "../wallets/profile.ts";

export type FinalDecision = "MOMENTUM" | "WATCH" | "CAUTION" | "AVOID" | "NO SIGNAL";
export type ReasonKind = "positive" | "negative" | "uncertainty" | "informational";
export type ReasonSource = "dex" | "onchain" | "wallet_intel";

export interface Reason {
  kind: ReasonKind;
  /** Canonical identity of the fact: two observations with the same id are the same evidence. */
  fact: string;
  text: string;
  /** Strength of a negative fact (existing severities / link strengths), when known. */
  severity: "high" | "medium" | "low" | null;
  sources: ReasonSource[];
}

export interface FinalAssessment {
  decision: FinalDecision;
  baseDexLabel: Label | null;
  baseDecision: FinalDecision;
  /** Confirmed hard blockers (AVOID). */
  blockers: Reason[];
  /** Confirmed structural cautions (MOMENTUM / WATCH / HIGH RISK → CAUTION). */
  cautions: Reason[];
  positives: Reason[];
  negatives: Reason[];
  uncertainties: Reason[];
  informational: Reason[];
  dataConfidence: {
    dex: PairScore["confidence"]["level"];
    onchain: OnchainResult["analysis"]["confidence"] | null;
    /** Wallets per Data Confidence level; null when Wallet Intelligence was not run. */
    wallets: Record<DataConfidence, number> | null;
  };
  /** Decision explanation: base, final, what changed (or why nothing did). */
  why: string[];
}

export interface AssessmentInput {
  score: PairScore;
  onchain?: OnchainResult | null;
  wallets?: WalletIntel | null;
}

const BASE: Record<Label, FinalDecision> = { MOMENTUM: "MOMENTUM", WATCH: "WATCH", "HIGH RISK": "CAUTION" };
/** Confirmed Step 3 red flags that block (V1). */
const HARD_BLOCKERS: RedFlagKey[] = ["freezeAuthority", "extension:nonTransferable", "extension:defaultAccountState", "extension:permanentDelegate"];
/** Confirmed Step 3 red flags that degrade MOMENTUM / WATCH to CAUTION (V1); extreme concentration is checked separately. */
const CAUTION_FLAGS: RedFlagKey[] = ["mintAuthority", "creatorHolding", "creatorSold", "creatorTransfers", "extension:transferHook"];
/** Step 3 red flags whose content is presented as canonical relationships instead. */
const RELATION_FLAGS: RedFlagKey[] = ["relatedGroup"];

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const pct = (n: number) => `${n.toFixed(2)} %`;

const LINK_TEXT: Record<LinkType, string> = {
  sameTx: "financés dans la même transaction",
  fundedBy: "l'un financé par l'autre",
  sharedTx: "apparaissent ensemble dans les mêmes transactions",
  sameFunderClose: "même financeur (peu actif) à quelques minutes d'écart",
  sameFunder: "même financeur (peu actif) à des moments différents",
  sameBusyFunder: "même financeur très actif (probablement un exchange ou un service) : non probant",
  sameFunderUnknownActivity: "même financeur dont l'activité est inconnue : preuve insuffisante",
  timing: "première activité proche dans le temps : non probant",
};
/** Funder-keyed link types: the key (funder or funding signature) is the shared evidence. */
const KEYED: LinkType[] = ["sameTx", "sameFunderClose", "sameFunder", "sameBusyFunder", "sameFunderUnknownActivity"];

/** One canonical relation per (type, pair, key); merged across engines only on that exact identity. */
function relationReasons(links: { link: WalletLink; source: ReasonSource }[]): Reason[] {
  const byPair = new Map<string, { link: WalletLink; sources: Set<ReasonSource> }>();
  for (const { link, source } of links) {
    const [x, y] = [link.a, link.b].sort();
    const id = `${link.type}|${x}|${y}|${link.key ?? ""}`;
    const cur = byPair.get(id) ?? { link, sources: new Set<ReasonSource>() };
    cur.sources.add(source);
    byPair.set(id, cur);
  }
  // Presentation only (relations, clusters and counts unchanged):
  //   keyed evidence (funder / funding signature) → one line per (type, key);
  //   sharedTx → one line per connected component of sharedTx pairs;
  //   other types → one line per pair.
  type Line = { type: LinkType; key: string | null; strength: WalletLink["strength"]; pairs: { a: string; b: string; sources: Set<ReasonSource> }[] };
  const lines = new Map<string, Line>();
  const shared: { id: string; link: WalletLink; sources: Set<ReasonSource> }[] = [];
  for (const [id, { link, sources }] of byPair) {
    if (link.type === "sharedTx") {
      shared.push({ id, link, sources });
      continue;
    }
    const lineId = KEYED.includes(link.type) && link.key !== null ? `${link.type}|${link.key}` : id;
    const cur = lines.get(lineId) ?? { type: link.type, key: link.key, strength: link.strength, pairs: [] };
    cur.pairs.push({ a: link.a, b: link.b, sources });
    lines.set(lineId, cur);
  }
  // Connected components of sharedTx pairs (union-find over wallets, presentation only).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const { link } of shared) parent.set(find(link.a), find(link.b));
  const components = new Map<string, typeof shared>();
  for (const e of shared) {
    const root = find(e.link.a);
    components.set(root, [...(components.get(root) ?? []), e]);
  }
  for (const members of components.values()) {
    const wallets = [...new Set(members.flatMap((m) => [m.link.a, m.link.b]))].sort();
    const lineId = members.length === 1 ? members[0].id : `sharedTx|component|${wallets.join("|")}`;
    lines.set(lineId, { type: "sharedTx", key: null, strength: "strong", pairs: members.map((m) => ({ a: m.link.a, b: m.link.b, sources: m.sources })) });
  }

  const ENGINE: Record<ReasonSource, string> = { dex: "DEX", onchain: "on-chain", wallet_intel: "Wallet Intelligence" };
  const out: Reason[] = [];
  for (const [lineId, l] of lines) {
    const sources = new Set(l.pairs.flatMap((p) => [...p.sources]));
    const wallets = [...new Set(l.pairs.flatMap((p) => [p.a, p.b]))];
    const who =
      l.pairs.length === 1
        ? `${short(l.pairs[0].a)} ↔ ${short(l.pairs[0].b)}`
        : l.type === "sharedTx"
          ? `${wallets.length} wallets reliés, ${l.pairs.length} paires (${wallets.map(short).join(", ")})`
          : `${l.pairs.length} paires (${wallets.map(short).join(", ")})`;
    const via = l.key && KEYED.includes(l.type) ? ` [${l.type === "sameTx" ? "transaction" : "financeur"} ${short(l.key)}]` : "";
    // Which engine saw which pairs: a pair seen by both engines counts for each, and is reported as shared.
    const provenance =
      sources.size > 1
        ? ` — provenance : ${[...sources].sort().map((src) => `${ENGINE[src]} ${l.pairs.filter((p) => p.sources.has(src)).length} paire(s)`).join(" · ")}${(() => {
            const both = l.pairs.filter((p) => p.sources.size > 1).length;
            return both ? ` (dont ${both} vue(s) par les deux moteurs)` : " (paires différentes)";
          })()}`
        : "";
    const kind: ReasonKind = l.strength === "strong" || l.strength === "medium" ? "negative" : l.strength === "weak" ? "informational" : "uncertainty";
    const tag = l.strength === "strong" ? "Relation forte" : l.strength === "medium" ? "Relation moyenne" : "Relation";
    out.push({
      kind,
      fact: `relation:${lineId}`,
      text: `${tag} (${l.type}) : ${who} — ${LINK_TEXT[l.type]}${via}${provenance}`,
      severity: l.strength === "strong" ? "high" : l.strength === "medium" ? "medium" : null,
      sources: [...sources].sort(),
    });
  }
  return out;
}

function reason(kind: ReasonKind, fact: string, text: string, source: ReasonSource, severity: Reason["severity"] = null): Reason {
  return { kind, fact, text, severity, sources: [source] };
}

export function assessToken(input: AssessmentInput, oc: OnchainConfig = ONCHAIN_CONFIG): FinalAssessment {
  const { score } = input;
  const analysis = input.onchain?.analysis ?? null;
  const intel = input.wallets ?? null;
  const all: Reason[] = [];
  const blockers: Reason[] = [];
  const cautions: Reason[] = [];

  // ─── DEX (Step 2): interest / timing ─────────────────────────────────
  const baseDexLabel = score.label;
  const baseDecision: FinalDecision = baseDexLabel ? BASE[baseDexLabel] : "NO SIGNAL";
  all.push(reason("informational", "dex:scores", `DEX : Opportunity ${score.opportunity}/100, Risk ${score.risk}/100, Quality ${score.quality}/100, Confidence ${score.confidence.level} — ${score.labelReason}`, "dex"));
  for (const t of score.signals.positive) all.push(reason("positive", `dex:+:${t}`, t, "dex"));
  // Missing DEX fields are an absence of data: uncertainty, never a negative reason. Step 2 reports the
  // same missing fields twice (the missingData risk factor and "Données absentes"): one canonical reason
  // for the fields both name; fields only one of them names stay a separate reason.
  const missingFactor = score.riskFactors.find((f) => f.key === "missingData") ?? null;
  const absentText = score.missingFields.length ? `Données absentes : ${score.missingFields.join(", ")}` : null;
  const factorText = missingFactor ? `${missingFactor.label} : ${missingFactor.input} (+${missingFactor.points} risk)` : null;
  for (const t of score.signals.negative) if (t !== absentText && t !== factorText) all.push(reason("negative", `dex:-:${t}`, t, "dex"));
  const factorFields = missingFactor ? missingFactor.input.split(", ") : [];
  const absentOnly = score.missingFields.filter((f) => !factorFields.includes(f));
  if (missingFactor && score.signals.negative.includes(factorText!)) {
    all.push(reason("uncertainty", `dex:missing:${factorFields.join(",")}`, `Données DEX absentes : ${factorFields.join(", ")} (+${missingFactor.points} DEX Risk, données manquantes)`, "dex"));
  }
  if (absentText && score.signals.negative.includes(absentText) && absentOnly.length) {
    all.push(reason("uncertainty", `dex:missing:${absentOnly.join(",")}`, `Données DEX absentes : ${absentOnly.join(", ")}`, "dex"));
  }

  // ─── On-chain (Step 3): confirmed facts only ─────────────────────────
  if (!analysis) {
    all.push(reason("uncertainty", "onchain:none", "Analyse on-chain non disponible : sécurité structurelle non vérifiée.", "onchain"));
  } else {
    for (const f of analysis.redFlagFacts) {
      if (RELATION_FLAGS.includes(f.key)) continue;
      const r = reason("negative", `onchain:${f.key}`, f.text, "onchain", HARD_BLOCKERS.includes(f.key) || CAUTION_FLAGS.includes(f.key) ? "high" : "medium");
      all.push(r);
      if (HARD_BLOCKERS.includes(f.key)) blockers.push(r);
      else if (CAUTION_FLAGS.includes(f.key)) cautions.push(r);
    }
    // Extreme concentration (existing Step 3 threshold), only on the adjusted basis: without the owner
    // classification, pools and bonding curves are not excluded and the raw figure is not reliable.
    const h = analysis.holders;
    const extreme = oc.score.concentration.extreme.top10;
    if (h?.adjusted && h.adjusted.top10 >= extreme) {
      const r = reason("negative", "onchain:extremeConcentration", `Top 10 extrêmement concentré : ${pct(h.adjusted.top10)} (ajusté, seuil Step 3 ${extreme} %).`, "onchain", "high");
      all.push(r);
      cautions.push(r);
    } else if (h && !h.adjusted && h.raw.top10 >= extreme) {
      all.push(reason("uncertainty", "onchain:extremeConcentration:raw", `Top 10 brut ${pct(h.raw.top10)} ≥ ${extreme} %, mais gros comptes non classés (pools / bonding curve non exclus) : concentration non confirmée.`, "onchain"));
    }
    for (const p of analysis.positives) all.push(reason("positive", `onchain:+:${p}`, p, "onchain"));
    for (const u of analysis.unknowns) all.push(reason("uncertainty", `onchain:?:${u}`, u, "onchain"));
    all.push(reason("informational", "onchain:score", `On-chain Risk ${analysis.risk}/100 (Confidence ${analysis.confidence}) : affiché, jamais utilisé comme gate (il compte aussi les données inconnues).`, "onchain"));
  }

  // ─── Relationships: Step 3 + Step 4, one reason per canonical relation ─
  const links: { link: WalletLink; source: ReasonSource }[] = [
    ...(analysis?.related?.links ?? []).map((link) => ({ link, source: "onchain" as const })),
    ...(intel?.related.links ?? []).map((link) => ({ link, source: "wallet_intel" as const })),
  ];
  all.push(...relationReasons(links));

  // ─── Wallet Intelligence (Step 4): confirmation / warnings ───────────
  let walletConfidence: Record<DataConfidence, number> | null = null;
  if (!intel) {
    all.push(reason("uncertainty", "wallets:none", "Wallet Intelligence non lancée : aucune confirmation par les wallets.", "wallet_intel"));
  } else {
    const tracked = intel.tracked;
    if (!tracked.length) {
      all.push(reason("uncertainty", "wallets:empty", "Wallet Intelligence exécutée, mais aucun wallet analysé (aucun acheteur ni wallet structurel retenu) : aucune confirmation, pas un signal négatif.", "wallet_intel"));
    }
    walletConfidence = { HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
    for (const t of tracked) walletConfidence[t.profile.dataConfidence]++;
    const creator = analysis?.creator?.address ?? null;

    // Links with the deployment-associated wallet, grouped by the same evidence (type + funder).
    const creatorLinks = new Map<string, { type: string; strength: string; key: string; wallets: string[] }>();
    for (const t of tracked) {
      const l = t.profile.creatorLink;
      if (!l) continue;
      const id = `${l.type}|${l.key}`;
      const cur = creatorLinks.get(id) ?? { type: l.type, strength: l.strength, key: l.key, wallets: [] };
      cur.wallets.push(t.address);
      creatorLinks.set(id, cur);
    }
    for (const [id, c] of creatorLinks) {
      const list = c.wallets.map(short).join(", ");
      if (c.type === "fundedByCreator") {
        const r = reason("negative", `creator:${id}`, `${c.wallets.length} wallet(s) financé(s) directement par le deployment-associated wallet${creator ? ` ${short(creator)}` : ""} : ${list}.`, "wallet_intel", "high");
        // Same evidence as a fundedBy relation (wallet ↔ deployment wallet, key = deployment wallet): one reason.
        for (const w of c.wallets) {
          const [x, y] = [w, c.key].sort();
          const i = all.findIndex((x2) => x2.fact === `relation:fundedBy|${x}|${y}|${c.key}`);
          if (i < 0) continue;
          r.sources = [...new Set([...r.sources, ...all[i].sources])].sort();
          all.splice(i, 1);
        }
        all.push(r);
      } else if (c.strength === "strong") {
        all.push(reason("negative", `creator:${id}`, `${c.wallets.length} wallet(s) avec le même financeur (peu actif) que le deployment-associated wallet, à quelques minutes d'écart [financeur ${short(c.key)}] : ${list}.`, "wallet_intel", "high"));
      } else if (c.strength === "medium") {
        all.push(reason("negative", `creator:${id}`, `${c.wallets.length} wallet(s) avec le même financeur (peu actif) que le deployment-associated wallet, à des moments différents [financeur ${short(c.key)}] : ${list}.`, "wallet_intel", "medium"));
      } else if (c.strength === "weak") {
        all.push(reason("informational", `creator:${id}`, `${c.wallets.length} wallet(s) partagent avec le deployment-associated wallet un financeur très actif [${short(c.key)}] : relation faible, non probante.`, "wallet_intel"));
      } else {
        all.push(reason("uncertainty", `creator:${id}`, `${c.wallets.length} wallet(s) partagent un financeur avec le deployment-associated wallet [${short(c.key)}], activité du financeur inconnue : preuve insuffisante.`, "wallet_intel"));
      }
    }

    // Other observed patterns, once per pattern; creator links and related are reported above,
    // flags neutralised by the same evidence (suppressedBy) and the data status are not repeated.
    const SKIP = new Set(["fundedByCreator", "sameFunderAsCreator", "related", "incomplete", "creator"]);
    const patterns = new Map<string, { label: string; severity: Reason["severity"]; wallets: string[] }>();
    for (const t of tracked) {
      for (const fl of t.profile.flags) {
        if (SKIP.has(fl.key) || fl.suppressedBy !== null) continue;
        const cur = patterns.get(fl.key) ?? { label: fl.label, severity: fl.severity, wallets: [] };
        cur.wallets.push(t.address);
        patterns.set(fl.key, cur);
      }
    }
    for (const [key, p] of patterns) all.push(reason("negative", `wallets:flag:${key}`, `${p.wallets.length}/${tracked.length} wallet(s) : ${p.label} (${p.severity}) — ${p.wallets.map(short).join(", ")}.`, "wallet_intel", p.severity));

    if (intel.highQualityWithoutHighRiskFlags > 0) {
      all.push(reason("positive", "wallets:highQuality", `${intel.highQualityWithoutHighRiskFlags} wallet(s) de qualité mesurée (Wallet Quality ≥ ${WALLET_CONFIG.highQualityThreshold}, Data Confidence MEDIUM/HIGH) sans risque HIGH appliqué : confirmation, ne relève pas la décision.`, "wallet_intel"));
    }
    const below = tracked.filter((t) => t.profile.quality.status === "measured" && t.profile.quality.value < WALLET_CONFIG.highQualityThreshold);
    if (below.length) {
      all.push(reason("negative", "wallets:belowThreshold", `${below.length}/${intel.measured} wallet(s) à Quality mesurée sous ${WALLET_CONFIG.highQualityThreshold} (${below.map((t) => (t.profile.quality.status === "measured" ? t.profile.quality.value : "")).join(", ")}) : historique peu convaincant, pas un signe de scam.`, "wallet_intel", "low"));
    }
    if (intel.unknown > 0) {
      const parts = Object.entries(intel.unknownByReason).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
      all.push(reason("uncertainty", "wallets:qualityUnknown", `${intel.unknown}/${tracked.length} wallet(s) à Wallet Quality UNKNOWN (${parts.join(", ")}) : moins de certitude, pas un signal négatif.`, "wallet_intel"));
    }
    const lowData = walletConfidence.LOW + walletConfidence.UNKNOWN;
    if (tracked.length && lowData > 0) {
      all.push(reason("uncertainty", "wallets:dataConfidence", `Data Confidence des wallets : HIGH ${walletConfidence.HIGH} · MEDIUM ${walletConfidence.MEDIUM} · LOW ${walletConfidence.LOW} · UNKNOWN ${walletConfidence.UNKNOWN}.`, "wallet_intel"));
    }
    all.push(reason("informational", "wallets:clusters", `${tracked.length} wallet(s) suivis, ${intel.independentClusters} cluster(s) indépendant(s).`, "wallet_intel"));
  }

  // ─── Decision ────────────────────────────────────────────────────────
  let decision = baseDecision;
  const why = [`BASE: ${baseDexLabel ? `DEX ${baseDexLabel}` : "aucun label DEX"} → ${baseDecision}`];
  if (blockers.length) {
    decision = "AVOID";
    why.push(`FINAL: AVOID`, ...blockers.map((b) => `WHY CHANGED: hard blocker confirmé — ${b.text}`));
  } else if (cautions.length && baseDecision !== "NO SIGNAL") {
    decision = "CAUTION";
    // "WHY CHANGED" only when the decision actually changed (DEX HIGH RISK is already CAUTION).
    const changed = baseDecision !== "CAUTION";
    why.push(
      `FINAL: CAUTION`,
      ...(changed ? [] : [`WHY: DEX HIGH RISK (${score.labelReason})`]),
      ...cautions.map((c) => (changed ? `WHY CHANGED: caution structurelle confirmée — ${c.text}` : `STRUCTURAL CAUTION: confirmée aussi — ${c.text}`)),
    );
  } else {
    why.push(`FINAL: ${decision}`);
    if (baseDecision === "CAUTION") why.push(`WHY: DEX HIGH RISK (${score.labelReason})`);
    why.push(cautions.length ? "WHY: caution structurelle observée, mais aucun label DEX à dégrader (NO SIGNAL reste NO SIGNAL)." : "WHY: aucun hard blocker ni caution structurelle confirmé.");
  }

  const of = (k: ReasonKind) => all.filter((r) => r.kind === k);
  return {
    decision,
    baseDexLabel,
    baseDecision,
    blockers,
    cautions,
    positives: of("positive"),
    negatives: of("negative"),
    uncertainties: of("uncertainty"),
    informational: of("informational"),
    dataConfidence: { dex: score.confidence.level, onchain: analysis?.confidence ?? null, wallets: walletConfidence },
    why,
  };
}

const MARK: Record<ReasonKind, string> = { positive: "+", negative: "-", uncertainty: "?", informational: "i" };

/** Plain-text form for scripts and debugging. */
export function formatAssessment(a: FinalAssessment): string {
  const src = (r: Reason) => (r.sources.length > 1 ? ` [${r.sources.join(" + ")}]` : "");
  const section = (title: string, rs: Reason[]) => (rs.length ? [`${title}:`, ...rs.map((r) => `${MARK[r.kind]} ${r.text}${src(r)}`)] : []);
  const w = a.dataConfidence.wallets;
  return [
    `FINAL: ${a.decision}`,
    `BASE: ${a.baseDexLabel ? `DEX ${a.baseDexLabel}` : "aucun label DEX"}`,
    ...a.why.filter((l) => !l.startsWith("BASE:") && !l.startsWith("FINAL:")),
    `DATA CONFIDENCE: DEX ${a.dataConfidence.dex} · on-chain ${a.dataConfidence.onchain ?? "non analysé"} · wallets ${w ? `HIGH ${w.HIGH} / MEDIUM ${w.MEDIUM} / LOW ${w.LOW} / UNKNOWN ${w.UNKNOWN}` : "non analysés"}`,
    ...section("POSITIVE", a.positives),
    ...section("NEGATIVE", a.negatives),
    ...section("UNCERTAINTY", a.uncertainties),
    ...section("INFORMATIONAL", a.informational),
  ].join("\n");
}
