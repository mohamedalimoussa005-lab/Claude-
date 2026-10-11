/**
 * Writes a CoordinationResult into the Evidence Ledger, keeping three kinds of content strictly apart:
 *
 *   observed     transactions and funding transfers actually read          → FACT, derivation "observed"
 *   computed     exact counts / indices over those transactions            → FACT (exact, complete data)
 *                                                                           or INDICATION (statistical, or data partial)
 *   hypothesis   a possible explanation compatible with several indications → HYPOTHESIS, derivation "estimated"
 *                (an interpretation is never an exact computation)
 *
 * What could not be read is recorded as UNVERIFIED (`data_gap`). Nothing recorded here says that a group is
 * controlled by one party; the strongest entry is a HYPOTHESIS that lists the ordinary explanations it cannot exclude.
 */

import type { EvidenceLedger } from "../ledger.ts";
import type { EvidenceFact } from "../types.ts";
import type { CoordinationResult } from "./analyze.ts";
import type { SwapEvent } from "./model.ts";

export interface CoordinationEvidenceArgs {
  ledger: EvidenceLedger;
  result: CoordinationResult;
  /** When the transactions were read (ISO 8601 UTC). */
  observedAt: string;
  /** Upper bound on observed transaction/funding entries written per group or indicator (ledger size). */
  maxAnchors?: number;
}

export interface CoordinationEvidenceIds {
  gaps: string[];
  launch: string | null;
  funding: string[];
  creatorLinks: string | null;
  groups: string[];
  hypotheses: string[];
  wash: string | null;
}

const f = (key: string, value: EvidenceFact["value"]): EvidenceFact => ({ key, value });
const r4 = (n: number | null): number | null => (n === null || !Number.isFinite(n) ? null : Math.round(n * 1e4) / 1e4);
const sol = (l: bigint): number => Math.round(Number(l) / 1e5) / 1e4; // lamports → SOL, 4 decimals (funding is always SOL)
const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString());

export function recordCoordinationEvidence(a: CoordinationEvidenceArgs): CoordinationEvidenceIds {
  const { ledger, result: r, observedAt } = a;
  const cap = a.maxAnchors ?? 12;
  const mint = r.mint;
  /** Quote amounts in human units when the decimals are known, else raw units as a string (never a guess). */
  const q = (l: bigint): number | string => (r.quoteDecimals === null ? l.toString() : Math.round((Number(l) / 10 ** r.quoteDecimals) * 1e6) / 1e6);
  const out: CoordinationEvidenceIds = { gaps: [], launch: null, funding: [], creatorLinks: null, groups: [], hypotheses: [], wash: null };
  const partial = r.scopeLimited || !r.coverage.signaturesComplete || r.coverage.transactionsMissing > 0 || r.funding.wallets.some((w) => w.partial);

  // ---- gaps (UNVERIFIED) -------------------------------------------------------------------------------
  const gap = (summary: string, missing: string[], addresses: string[] = []) => {
    out.gaps.push(
      ledger.add({ mint, type: "data_gap", source: "solana_rpc", status: "UNVERIFIED", summary, facts: [], observedAt, addresses, missing, limits: ["lacune de données: toute mesure qui en dépend est une borne, pas une valeur exacte"] }).id,
    );
  };
  if (!r.coverage.signaturesComplete) gap("Historique du token non remonté jusqu'à sa première transaction", ["premières transactions du token", "acheteurs réels du lancement"]);
  if (r.scopeLimited) gap(`Analyse limitée aux ${r.coverage.transactionsRead} transactions les plus anciennes sur ${r.coverage.signaturesRead} listées`, ["activité postérieure du token (ventes, volume, nouveaux acheteurs)"]);
  if (r.coverage.transactionsMissing > 0) gap(`${r.coverage.transactionsMissing} transaction(s) listée(s) mais non obtenue(s)`, ["contenu de ces transactions (erreur RPC ou historique élagué)"]);
  if (r.funding.notTraced.length > 0) gap(`${r.funding.notTraced.length} wallet(s) de la cohorte non remontés (plafond de remontée)`, ["financement de ces wallets"], r.funding.notTraced.slice(0, 20));
  if (r.funding.unavailable.length > 0) gap(`${r.funding.unavailable.length} wallet(s) sans historique de financement disponible`, ["historique de ces wallets"], r.funding.unavailable.slice(0, 20));
  const cn = r.funding.notes.find((n) => n.startsWith("historique du créateur"));
  if (cn) gap(`Financement du créateur non établi: ${cn}`, ["premier financement du créateur", "financeurs du créateur"], r.funding.creatorChain.slice(0, 1));
  const partialWallets = r.funding.wallets.filter((w) => w.partial);
  if (partialWallets.length > 0) gap(`${partialWallets.length} wallet(s) avec historique partiel`, ["premier financement réel de ces wallets (le premier observé peut ne pas être le premier)"], partialWallets.slice(0, 20).map((w) => w.wallet));

  // ---- observed transactions that support reported items -----------------------------------------------
  const txId = new Map<string, string>();
  const swapBySig = new Map(r.swaps.map((s) => [s.signature, s]));
  const recordSwap = (sig: string): string | null => {
    const hit = txId.get(sig);
    if (hit) return hit;
    const s: SwapEvent | undefined = swapBySig.get(sig);
    if (!s) return null;
    const e = ledger.add({
      mint,
      type: "transaction",
      source: "solana_rpc",
      status: "FACT",
      derivation: "observed",
      summary: `${s.side === "buy" ? "Achat" : "Vente"} du token par ${s.trader} au slot ${s.slot}`,
      facts: [f("side", s.side), f("trader", s.trader), f("baseAmountRaw", s.baseAmount.toString()), f("quoteMint", r.quoteMint), f("quoteApprox", q(s.quoteAmount))],
      observedAt,
      eventTime: iso(s.blockTime),
      signature: s.signature,
      slot: s.slot,
      addresses: [s.trader],
      limits: ["montant de cotation approximatif (en SOL: frais, loyers de comptes et pourboires retirés)", "ordre à l'intérieur du slot inconnu"],
    });
    txId.set(sig, e.id);
    return e.id;
  };
  const recordMany = (sigs: readonly string[]) => [...new Set(sigs)].sort().slice(0, cap).map(recordSwap).filter((x): x is string => x !== null);

  // ---- launch concentration ----------------------------------------------------------------------------
  const L = r.launch;
  if (L.cohort.length > 0) {
    const anchors = recordMany([L.cohort[0]!.firstBuySignature, ...L.cohort.filter((m) => m.firstBuySlot === L.firstSlot).map((m) => m.firstBuySignature)]);
    if (anchors.length > 0) {
      const s = L.sync;
      out.launch = ledger.add({
        mint,
        type: "same_slot_activity",
        source: "solana_rpc",
        status: "INDICATION",
        derivation: L.launchObserved && r.coverage.transactionsMissing === 0 ? "computed" : "estimated",
        summary: `${L.cohort.length} premiers acheteurs: ${L.buyersFirstSlot} au premier slot, ${L.buyersWithin5Slots} dans les 5 premiers`,
        facts: [
          f("launchObserved", L.launchObserved),
          f("cohortSize", L.cohort.length),
          f("buyersFirstSlot", L.buyersFirstSlot),
          f("buyersWithin5Slots", L.buyersWithin5Slots),
          f("cohortNetSupplyShare", r4(L.cohortSupplyShare)),
          f("cohortGrossBuyShare", r4(L.cohortGrossBuyShare)),
          f("top5BuyShare", r4(L.top5BuyShare)),
          f("hhiQuote", r4(L.hhiQuote)),
          f("giniQuote", r4(L.giniQuote)),
          f("syncPairsObserved", s.observedPairs),
          f("syncPairsExpected", r4(s.expectedPairs)),
          f("syncPValue", r4(s.pValue)),
          f("syncUnusual", s.unusual),
          f("creatorBuys", L.creatorBuys.length),
          f("excludedEntities", L.excluded.length),
        ],
        observedAt,
        slot: L.firstSlot,
        basedOn: anchors,
        limits: [
          "indice statistique: p-value Monte-Carlo contre la distribution des achats de la fenêtre elle-même (graine fixe)",
          "un lancement populaire concentre naturellement les achats dans les premiers slots",
          ...L.notes,
        ],
        missing: L.launchObserved ? [] : ["lancement réel non atteint"],
      }).id;
    }
  }

  const edgeId = new Map<string, string>();
  // ---- shared funding sources --------------------------------------------------------------------------
  for (const s of r.funding.shared.slice(0, 20)) {
    const wallets = s.wallets.slice(0, cap);
    const sigs = s.signatures.slice(0, cap);
    const based = sigs.map((sig) => {
      const edge = r.funding.wallets.flatMap((x) => x.chain).find((c) => c.signature === sig && c.hop === s.hop && c.from === s.source);
      if (!edge) return null;
      const key = `${edge.signature}|${edge.to}|${edge.hop}`;
      const cached = edgeId.get(key);
      if (cached) return cached;
      const added = ledger.add({
        mint,
        type: "funding_link",
        source: "solana_rpc",
        status: "FACT",
        derivation: "observed",
        summary: `${edge.from} a envoyé du SOL à ${edge.to} (saut ${edge.hop})`,
        facts: [f("from", edge.from), f("to", edge.to), f("sol", sol(edge.lamports)), f("hop", edge.hop)],
        observedAt,
        eventTime: iso(edge.blockTime),
        signature: edge.signature,
        slot: edge.slot,
        addresses: [edge.from, edge.to],
        limits: s.partial ? ["historique partiel: ce transfert n'est peut-être pas le premier financement du wallet"] : ["transfert SOL système uniquement (les dépôts via jetons enveloppés ne sont pas vus)"],
      }).id;
      edgeId.set(key, added);
      return added;
    }).filter((x): x is string => x !== null);
    if (based.length === 0) continue;
    const exact = !s.partial && s.wallets.length <= cap;
    out.funding.push(
      ledger.add({
        mint,
        type: "funding_link",
        source: "solana_rpc",
        status: exact ? "FACT" : "INDICATION",
        derivation: exact ? "computed" : "estimated",
        summary: s.discriminating
          ? `${s.wallets.length} wallets de la cohorte partagent la source de financement ${s.source} (saut ${s.hop})`
          : `${s.wallets.length} wallets de la cohorte partagent ${s.entity ? `l'entité ${s.entity.label}` : "un wallet très actif"} comme source (saut ${s.hop}): non discriminant`,
        facts: [f("source", s.source), f("hop", s.hop), f("wallets", s.wallets.length), f("cohortShare", r4(s.cohortShare)), f("discriminating", s.discriminating), f("entity", s.entity?.label ?? null), f("probableService", s.probableService), f("similarAmounts", s.similarAmounts), f("burst", s.burst), f("sourceInCohort", s.sourceInCohort)],
        observedAt,
        addresses: [s.source, ...wallets],
        basedOn: based,
        limits: [
          s.discriminating ? "une source commune ne prouve pas un propriétaire commun (plateforme non étiquetée, amis, bot public)" : "la source est une entité ou un wallet très actif: ce partage ne dit rien sur les wallets concernés",
          ...(s.wallets.length > cap ? [`liste tronquée à ${cap} wallets dans les ancres`] : []),
        ],
      }).id,
    );
  }

  // ---- wallets that received SOL from the creator or from the creator's funders ------------------------
  if (r.funding.creatorLinks.length > 0) {
    const links = r.funding.creatorLinks.slice(0, cap);
    const based = links.map((l) => {
      const key = `${l.signature}|${l.wallet}|creator`;
      const cached = edgeId.get(key);
      if (cached) return cached;
      const slotTime = r.funding.wallets.flatMap((x) => x.chain).find((c) => c.signature === l.signature)?.blockTime ?? null;
      const id = ledger.add({
        mint,
        type: "funding_link",
        source: "solana_rpc",
        status: "FACT",
        derivation: "observed",
        summary: `${l.kind === "creator" ? "Le créateur" : "Un financeur du créateur"} (${l.source}) a envoyé du SOL à ${l.wallet}`,
        facts: [f("from", l.source), f("to", l.wallet), f("sol", sol(l.lamports)), f("kind", l.kind), f("firstFunding", l.firstFunding)],
        observedAt,
        eventTime: iso(slotTime),
        signature: l.signature,
        slot: l.slot,
        addresses: [l.source, l.wallet],
        limits: ["transfert SOL système uniquement", "le créateur peut avoir financé des acheteurs légitimes (équipe, concours, cadeaux)"],
      }).id;
      edgeId.set(key, id);
      return id;
    });
    out.creatorLinks = ledger.add({
      mint,
      type: "funding_link",
      source: "solana_rpc",
      status: "FACT",
      derivation: "computed",
      summary: `${new Set(r.funding.creatorLinks.map((l) => l.wallet)).size} wallet(s) de la cohorte ont reçu du SOL du créateur ou d'un de ses financeurs`,
      facts: [f("wallets", new Set(r.funding.creatorLinks.map((l) => l.wallet)).size), f("transfers", r.funding.creatorLinks.length), f("creatorChainLength", r.funding.creatorChain.length), f("firstFundingLinks", r.funding.creatorLinks.filter((l) => l.firstFunding).length)],
      observedAt,
      addresses: r.funding.creatorChain.slice(0, 3),
      basedOn: based,
      limits: ["lien factuel de financement, pas une preuve de contrôle commun", ...(r.funding.creatorLinks.length > cap ? [`ancres tronquées à ${cap} transferts`] : []), ...(partial ? ["historiques partiels: des liens ont pu échapper"] : [])],
    }).id;
  }

  // ---- groups ------------------------------------------------------------------------------------------
  for (const g of r.cluster.groups) {
    const sigs = g.anchors;
    const based = recordMany(sigs);
    // funding anchors are funding transfers, not swaps: they are covered by the funding entries above
    const fundingBasis = out.funding.slice(0, cap);
    const basis = [...based, ...(g.families.includes("funding") ? fundingBasis : [])];
    if (basis.length === 0) continue;
    const gid = ledger.add({
      mint,
      type: "same_slot_activity",
      source: "solana_rpc",
      status: "INDICATION",
      derivation: partial ? "estimated" : "computed",
      summary: `${g.wallets.length} wallets partagent ${g.families.length} signal(aux) (${g.families.join(", ")})${g.strength === "single_signal" ? " — un seul signal" : ""}`,
      facts: [f("groupId", g.id), f("wallets", g.wallets.length), f("families", g.families.join(",")), f("strength", g.strength), f("baseShare", r4(g.baseShare)), f("pValueVsRestOfCohort", r4(g.pValue)), f("hypothesisEligible", g.hypothesisEligible)],
      observedAt,
      addresses: g.wallets.slice(0, 20),
      basedOn: basis,
      limits: [`explications ordinaires non exclues: ${g.counterExplanations.join(" ; ")}`, "ces similitudes décrivent des comportements, pas l'identité ni l'intention des propriétaires"],
    }).id;
    out.groups.push(gid);
    if (g.hypothesisEligible) {
      out.hypotheses.push(
        ledger.add({
          mint,
          type: "coordination_assessment",
          source: "solana_rpc",
          status: "HYPOTHESIS",
          derivation: "estimated",
          summary: `Hypothèse: le groupe ${g.id} (${g.wallets.length} wallets) est compatible avec une coordination; non démontrée`,
          facts: [f("groupId", g.id), f("families", g.families.join(",")), f("wallets", g.wallets.length)],
          observedAt,
          addresses: g.wallets.slice(0, 20),
          basedOn: [gid],
          limits: [`hypothèse, pas une preuve: ${g.families.length} familles de signaux indépendantes sont présentes, aucune ne prouve un contrôle commun`, `explications ordinaires non exclues: ${g.counterExplanations.join(" ; ")}`, "aucune conclusion de fraude"],
        }).id,
      );
    }
  }

  // ---- artificial volume -------------------------------------------------------------------------------
  const W = r.wash;
  if (W.swaps > 0) {
    const top = [...W.roundTrips].sort((x, y) => (y.quoteBuy + y.quoteSell > x.quoteBuy + x.quoteSell ? 1 : -1)).slice(0, Math.floor(cap / 2));
    const based = recordMany(top.flatMap((t) => [t.buySignature, t.sellSignature]));
    const swapAnchor = based.length > 0 ? based : recordMany(r.swaps.slice(0, 1).map((s) => s.signature));
    if (swapAnchor.length > 0) {
      out.wash = ledger.add({
        mint,
        type: "round_trip_volume",
        source: "solana_rpc",
        status: "INDICATION",
        derivation: partial ? "estimated" : "computed",
        summary: `Aller-retours: ${W.roundTripShare === null ? "n/a" : (W.roundTripShare * 100).toFixed(1) + " %"} du volume jugé (${W.roundTripWallets.length} wallets)`,
        facts: [
          f("swaps", W.swaps),
          f("judgedSwaps", W.judgedSwaps),
          f("distinctTraders", W.distinctTraders),
          f("quoteMint", r.quoteMint), f("grossQuoteApprox", q(W.grossQuote)),
          f("excludedQuoteApprox", q(W.excludedQuote)),
          f("roundTripShare", r4(W.roundTripShare)),
          f("roundTripWallets", W.roundTripWallets.length),
          f("top5VolumeShare", r4(W.top5VolumeShare)),
          f("nullMeanShare", r4(W.permutation?.nullMean ?? null)),
          f("nullP95Share", r4(W.permutation?.nullP95 ?? null)),
          f("permutationPValue", r4(W.permutation?.pValue ?? null)),
          f("metronomicWallets", W.cadence.filter((c) => c.metronomic).length),
          f("transferCycles", W.transferCycles.length),
          f("flags", W.flags.length),
        ],
        observedAt,
        basedOn: swapAnchor,
        limits: [...W.counterExplanations, "indicateur de mesure: aucun seuil n'est validé sur des cas étiquetés", ...W.notes],
      }).id;
    }
  }
  return out;
}
