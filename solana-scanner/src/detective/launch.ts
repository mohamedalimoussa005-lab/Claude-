/**
 * Launch window, first buyers, funding, coordination and repetitive volume — the 5A/5C/5D engines connected to
 * real, budgeted reads. Every cap is declared; a missing or partial history is UNKNOWN, never "nothing found".
 * No coordination hypothesis is produced (they are disabled in the engine's configuration).
 */

import type { ParsedTransaction, SignatureInfo } from "../onchain/rpc.ts";
import { analyzeCoordination, normalizeTx, recordCoordinationEvidence, withConfig } from "../social/coordination/index.ts";
import type { CoordinationResult, Coverage, NormalizedTx, RawTx, WalletFundingHistory } from "../social/coordination/index.ts";
import type { EvidenceLedger } from "../social/ledger.ts";
import { BudgetError } from "./meter.ts";
import type { Meter, ReadRpc } from "./meter.ts";
import type { ModeConfig } from "./modes.ts";
import type { Resolution } from "./resolve.ts";
import type { Finding, ReportSection } from "./types.ts";
import { section } from "./types.ts";

export interface LaunchArgs {
  rpc: ReadRpc;
  mint: string;
  res: Resolution;
  mode: ModeConfig;
  meter: Meter;
  ledger: EvidenceLedger;
  observedAt: string;
  creator: string | null;
  supplyRaw: string | null;
  sleep?: (ms: number) => Promise<void>;
}

export interface LaunchSections {
  firstBuyers: ReportSection;
  funding: ReportSection;
  repetitive: ReportSection;
  /** Ledger writers, run once the report is assembled. */
  record: ((ledger: EvidenceLedger) => void)[];
  evidenceUnknowns: string[];
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const pct = (n: number | null, d = 1) => (n === null ? "n/a" : `${(n * 100).toFixed(d)} %`);
const SIG_PAGE = 1000;

interface Paged {
  /** Newest first, as returned by the RPC. */
  sigs: SignatureInfo[];
  /** True only when the listing reached the oldest transaction of the address. */
  complete: boolean;
  pages: number;
  stopped: string | null;
}

async function pageSignatures(rpc: ReadRpc, address: string, maxPages: number, meter: Meter): Promise<Paged> {
  const sigs: SignatureInfo[] = [];
  let before: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    let page: SignatureInfo[];
    try {
      page = await rpc.getSignatures(address, SIG_PAGE, before);
    } catch (e) {
      return { sigs, complete: false, pages: p, stopped: e instanceof BudgetError ? e.message : `erreur RPC (${e instanceof Error ? e.message : String(e)})` };
    }
    sigs.push(...page);
    if (page.length < SIG_PAGE) return { sigs, complete: true, pages: p + 1, stopped: null };
    before = page[page.length - 1]!.signature;
  }
  meter.limit(`plafond de ${maxPages} page(s) de signatures atteint pour ${short(address)}`);
  return { sigs, complete: false, pages: maxPages, stopped: `plafond de ${maxPages} page(s) de signatures` };
}

interface Fetched {
  txs: NormalizedTx[];
  requested: number;
  failed: number;
  stopped: string | null;
}

/** The oldest `limit` successful transactions of a signature list (newest first). */
async function fetchOldest(rpc: ReadRpc, sigs: SignatureInfo[], limit: number): Promise<Fetched> {
  const ok = sigs.filter((s) => s.err === null || s.err === undefined);
  const pick = ok.slice(-limit).reverse();
  const txs: NormalizedTx[] = [];
  let failed = 0;
  for (const s of pick) {
    try {
      const tx = (await rpc.getTransaction(s.signature)) as ParsedTransaction | null;
      if (!tx || !tx.meta) {
        failed++;
        continue;
      }
      txs.push(normalizeTx({ ...tx, slot: tx.slot ?? s.slot ?? 0, blockTime: tx.blockTime ?? s.blockTime ?? null } as unknown as RawTx));
    } catch (e) {
      if (e instanceof BudgetError) return { txs, requested: pick.length, failed: failed + (pick.length - txs.length - failed), stopped: e.message };
      failed++;
    }
  }
  return { txs, requested: pick.length, failed, stopped: null };
}

function coverageOf(p: Paged, f: Fetched, notes: string[]): Coverage {
  const slots = p.sigs.map((s) => s.slot).filter((x): x is number => typeof x === "number");
  return { signaturesComplete: p.complete, signaturesRead: p.sigs.length, transactionsRead: f.txs.length, transactionsMissing: f.failed + (f.stopped ? f.requested - f.txs.length - f.failed : 0), oldestSlot: slots.length ? Math.min(...slots) : null, newestSlot: slots.length ? Math.max(...slots) : null, notes };
}

export async function buildLaunchSections(a: LaunchArgs): Promise<LaunchSections> {
  const { rpc, mint, mode, meter } = a;
  const title = { first: "Premiers acheteurs", fund: "Financements et wallets liés", rep: "Transactions répétitives" };
  const unknownAll = (why: string): LaunchSections => ({
    firstBuyers: section(title.first, { unknowns: [why] }),
    funding: section(title.fund, { unknowns: [why] }),
    repetitive: section(title.rep, { unknowns: [why] }),
    record: [],
    evidenceUnknowns: [why],
  });
  if (meter.exhausted) return unknownAll("budget épuisé avant la lecture du lancement");

  // 1. the oldest reachable transactions of the mint
  const mintSigs = await pageSignatures(rpc, mint, mode.launch.maxSignaturePages, meter);
  if (mintSigs.sigs.length === 0) return unknownAll(`aucune signature lue pour le mint${mintSigs.stopped ? ` (${mintSigs.stopped})` : ""}`);
  const launchReached = mintSigs.complete;
  const wanted = launchReached ? mode.launch.earlyTransactions : Math.min(mode.launch.earlyTransactions, 40);
  if (!launchReached) meter.limit(`lancement non atteint: ${mintSigs.sigs.length} signatures lues sans atteindre la première transaction du mint`);
  const early = await fetchOldest(rpc, mintSigs.sigs, wanted);
  if (early.stopped) meter.limit(`lecture des transactions du mint interrompue (${early.stopped})`);
  if (early.txs.length === 0) return unknownAll("aucune transaction du mint n'a pu être lue");
  const mintNotes: string[] = [];
  if (!launchReached) mintNotes.push(`${mintSigs.sigs.length} signatures lues (${mintSigs.pages} page(s)): la première transaction du mint n'a pas été atteinte`);
  const coverage = coverageOf(mintSigs, early, mintNotes);

  // 2. the cohort, with no funding data yet (same code path as the final analysis)
  const baseInput = { mint, creator: a.creator, supplyRaw: a.supplyRaw ? BigInt(a.supplyRaw) : null, txs: early.txs, coverage };
  const cfg = withConfig({ funding: { maxWallets: mode.launch.cohortWallets, maxHops: mode.launch.hops } });
  const first = analyzeCoordination({ ...baseInput, provider: () => null, cfg });
  const cohort = first.launch.cohort.map((m) => m.wallet).slice(0, mode.launch.cohortWallets);

  // 3. funding histories: creator first, then cohort wallets by rank, then their funders (hop 2)
  const histories = new Map<string, WalletFundingHistory | null>();
  const walletLimits: string[] = [];
  const fetchHistory = async (w: string): Promise<void> => {
    if (histories.has(w) || meter.exhausted) return;
    const p = await pageSignatures(rpc, w, mode.launch.walletSignaturePages, meter);
    if (p.sigs.length === 0) {
      histories.set(w, p.stopped ? null : { wallet: w, inbound: [], coverage: { signaturesComplete: true, signaturesRead: 0, transactionsRead: 0, transactionsMissing: 0, oldestSlot: null, newestSlot: null, notes: ["aucune signature"] } });
      return;
    }
    const f = await fetchOldest(rpc, p.sigs, mode.launch.walletTransactions);
    if (f.stopped) walletLimits.push(f.stopped);
    histories.set(w, { wallet: w, inbound: f.txs.flatMap((t) => t.solTransfers.filter((x) => x.to === w)), coverage: coverageOf(p, f, p.complete ? [] : [p.stopped ?? "historique plafonné"]), activityCapped: !p.complete });
  };
  const firstFunder = (w: string): string | null => {
    const h = histories.get(w);
    const min = cfg.funding.minFundingLamports;
    const t = [...(h?.inbound ?? [])].filter((x) => x.lamports >= min && x.from !== w).sort((x, y) => x.slot - y.slot)[0];
    return t?.from ?? null;
  };
  if (a.creator) await fetchHistory(a.creator);
  for (const w of cohort) await fetchHistory(w);
  if (mode.launch.hops >= 2) {
    const funders = new Set<string>();
    for (const w of [a.creator, ...cohort]) {
      const f = w ? firstFunder(w) : null;
      if (f && !histories.has(f)) funders.add(f);
    }
    for (const f of funders) await fetchHistory(f);
  }
  const notFetched = cohort.filter((w) => !histories.has(w)).length;
  if (notFetched > 0) meter.limit(`financement non lu pour ${notFetched} wallet(s) de la cohorte (budget)`);
  if (walletLimits.length) meter.limit(`lecture des transactions de wallets interrompue (${walletLimits[0]})`);

  // 4. the full analysis (5C/5D) on what was actually read
  const result = analyzeCoordination({ ...baseInput, provider: (w) => histories.get(w) ?? null, cfg });

  const sections = describe(result, a, { launchReached, cohortSize: cohort.length, notFetched });
  return {
    ...sections,
    record: [
      (ledger) => {
        try {
          recordCoordinationEvidence({ ledger, result, observedAt: a.observedAt });
        } catch (e) {
          sections.evidenceUnknowns.push(`preuves de coordination non enregistrées: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ],
  };
}

function describe(r: CoordinationResult, a: LaunchArgs, ctx: { launchReached: boolean; cohortSize: number; notFetched: number }): Omit<LaunchSections, "record"> {
  const L = r.launch;
  const cov = r.coverage;
  const scope = `${cov.transactionsRead} transaction(s) lue(s) sur ${cov.signaturesRead} signature(s) listée(s)${cov.signaturesComplete ? "" : " (historique du mint INCOMPLET)"}`;
  const synthFirst: Finding[] = [];
  const f1: Finding[] = [];
  const u1: string[] = [];

  f1.push({ level: "FAIT", text: `Lecture: ${scope}; ${r.swaps.length} swap(s) décodé(s), quote ${r.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : short(r.quoteMint)}.`, anchors: [a.mint] });
  if (!ctx.launchReached) {
    u1.push("le lancement réel (premières transactions du mint) n'a pas été atteint: les « premiers acheteurs » ci-dessous sont les plus anciens acheteurs LUS, pas ceux du lancement");
    synthFirst.push({ level: "INCONNU", text: "Le lancement du token n'a pas été atteint avec le budget: les premiers acheteurs réels sont inconnus." });
  }
  if (L.cohort.length === 0) {
    u1.push("aucun acheteur identifiable dans les transactions lues");
  } else {
    const firstSlot = L.firstSlot;
    f1.push({ level: "FAIT", text: `${L.cohort.length} acheteur(s) distinct(s) dans la fenêtre${ctx.launchReached ? " de lancement" : " lue"} (${L.swapsInWindow} swaps, premier slot ${firstSlot}); ${L.buyersFirstSlot} au premier slot, ${L.buyersWithin5Slots} dans les 5 premiers. L'ordre dans un même slot est inconnu.`, anchors: L.cohort.slice(0, 3).map((m) => m.firstBuySignature) });
    if (L.cohortSupplyShare !== null) f1.push({ level: "FAIT", text: `Part de l'offre encore détenue par ces acheteurs à la fin de la fenêtre lue (achats moins ventes): ${pct(L.cohortSupplyShare)}; achats bruts cumulés: ${pct(L.cohortGrossBuyShare)} de l'offre (peut dépasser 100 % si des wallets rachètent).` });
    f1.push({ level: "FAIT", text: `Concentration des achats de la cohorte: les 5 plus gros représentent ${pct(L.top5BuyShare)} des tokens achetés; HHI ${L.hhiQuote?.toFixed(3) ?? "n/a"}, Gini ${L.giniQuote?.toFixed(2) ?? "n/a"} (sur les montants payés).` });
    f1.push({ level: "INDICE", text: `Synchronie des premiers achats: ${L.sync.observedPairs} paire(s) d'acheteurs à ≤ 1 slot d'écart contre ${L.sync.baselineMeanPairs.toFixed(1)} attendues d'après le rythme d'arrivée du lancement lui-même (rapport ${L.sync.ratio?.toFixed(2) ?? "n/a"}). Mesure descriptive: aucune p-value, aucun verdict (un lancement populaire concentre naturellement les achats).` });
    if (L.creatorBuys.length) f1.push({ level: "FAIT", text: `Le wallet associé au déploiement a acheté ${L.creatorBuys.length} fois dans la fenêtre lue (compté à part).`, anchors: L.creatorBuys.slice(0, 3).map((b) => b.signature) });
    if (L.excluded.length) f1.push({ level: "INDICE", text: `${L.excluded.length} wallet(s) écartés de la cohorte (programmes, routeurs, bots ou créateur): ${L.excluded.slice(0, 4).map((x) => `${short(x.wallet)} (${x.reason})`).join(", ")}.` });
    synthFirst.push({ level: "FAIT", text: `Premiers acheteurs lus: ${L.cohort.length}; ils détiennent encore ${pct(L.cohortSupplyShare)} de l'offre à la fin de la fenêtre lue; top 5 = ${pct(L.top5BuyShare)} des achats de la cohorte.` });
  }
  for (const n of L.notes) if (!u1.includes(n) && !n.startsWith("ordre à l'intérieur")) u1.push(n);
  const firstBuyers = section("Premiers acheteurs", {
    status: L.cohort.length === 0 ? "unknown" : ctx.launchReached && !r.scopeLimited ? "ok" : "partial",
    data: { launchObserved: ctx.launchReached, cohortSize: L.cohort.length, firstSlot: L.firstSlot, buyersFirstSlot: L.buyersFirstSlot, buyersWithin5Slots: L.buyersWithin5Slots, netSupplyShare: L.cohortSupplyShare, grossBuyShare: L.cohortGrossBuyShare, top5BuyShare: L.top5BuyShare, hhi: L.hhiQuote, gini: L.giniQuote, sync: L.sync, creatorBuys: L.creatorBuys.length, excluded: L.excluded.length, coverage: cov, cohort: L.cohort.slice(0, 50).map((m) => ({ wallet: m.wallet, rank: m.rank, firstBuySlot: m.firstBuySlot, signature: m.firstBuySignature, buys: m.buys, sells: m.sells })), synthesis: synthFirst },
    findings: f1,
    unknowns: u1,
    limits: [scope, ...(r.scopeLimited ? ["lecture limitée aux transactions les plus anciennes du mint: l'activité plus récente n'est pas vue"] : [])],
  });

  // funding
  const F = r.funding;
  const f2: Finding[] = [];
  const u2: string[] = [];
  const synthFund: Finding[] = [];
  f2.push({ level: "FAIT", text: `Financement tracé pour ${F.wallets.length} wallet(s) de la cohorte (${F.knownCount} avec un premier financeur observé ou un historique complet sans financement, ${F.unknownCount} INCONNU); ${F.notTraced.length} non tracé(s) faute de plafond.` });
  if (ctx.notFetched > 0) u2.push(`${ctx.notFetched} wallet(s) dont l'historique n'a pas été lu (budget)`);
  if (F.unknownCount > 0) u2.push(`financement de ${F.unknownCount} wallet(s): historique absent ou partiel, l'absence de lien n'est PAS établie`);
  for (const s of F.shared.slice(0, 6)) {
    f2.push({ level: s.discriminating ? "FAIT" : "FAIT", text: `${s.wallets.length} wallets de la cohorte ont reçu leur ${s.hop === 1 ? "premier financement" : "financement (saut " + s.hop + ")"} de ${short(s.source)}${s.discriminating ? "" : ` — source NON discriminante (${s.entity?.label ?? (s.probableService ? "wallet très actif, probable service" : "entité connue")}): ce partage ne dit rien sur ces wallets`}${s.similarAmounts && s.discriminating ? "; montants proches" : ""}${s.burst && s.discriminating ? "; en rafale" : ""}${s.partial ? " (historique partiel)" : ""}. Un financeur commun n'est pas un propriétaire commun.`, anchors: s.signatures.slice(0, 3) });
  }
  if (F.shared.length === 0 && F.knownCount > 0) f2.push({ level: "FAIT", text: `Aucune source de financement commune parmi les ${F.knownCount} wallet(s) au financement connu.` });
  if (F.creatorLinks.length) f2.push({ level: "FAIT", text: `${new Set(F.creatorLinks.map((l) => l.wallet)).size} wallet(s) de la cohorte ont reçu du SOL du wallet associé au déploiement ou de l'un de ses financeurs. Lien factuel, pas une preuve de contrôle.`, anchors: F.creatorLinks.slice(0, 3).map((l) => l.signature) });
  else if (a.creator) f2.push({ level: F.notes.some((n) => n.includes("créateur")) ? "INCONNU" : "FAIT", text: F.notes.some((n) => n.includes("historique du créateur")) ? "Liens de financement avec le créateur: INCONNUS (historique du créateur partiel ou indisponible)." : "Aucun transfert de SOL du créateur ou de ses financeurs vers la cohorte lue." });
  else u2.push("créateur non identifié: liens de financement avec le créateur non évalués");
  const inf = r.cluster.inference;
  f2.push({ level: inf.status === "ok" ? "INDICE" : "INCONNU", text: `Test statistique des groupes: ${inf.status === "ok" ? `exécuté sur ${inf.knownWallets} wallet(s) au financement connu (${inf.permutations} permutations; validé sur benchmarks synthétiques seulement). Un p ajusté n'est PAS une probabilité de fraude.` : `${inf.status.toUpperCase()} — ${inf.reason ?? ""}`}` });
  for (const g of r.cluster.groups.slice(0, 6)) {
    f2.push({ level: "INDICE", text: `Groupe de ${g.wallets.length} wallets (${g.wallets.slice(0, 4).map(short).join(", ")}${g.wallets.length > 4 ? "…" : ""}) partageant ${g.families.join(" + ")}${g.strength === "single_signal" ? " (un seul signal)" : ""}; ${g.inference === "ok" ? `p ajusté ${g.adjustedP!.toFixed(3)}${g.significant ? ", significatif" : ", non significatif"}` : `sans p-value (${g.inference})`}. Ressemblance de comportement ou de financement, jamais un propriétaire commun; explications ordinaires: ${g.counterExplanations.slice(0, 3).join(" ; ")}.`, anchors: g.anchors.slice(0, 3) });
  }
  if (r.cluster.groups.length === 0) f2.push({ level: "FAIT", text: "Aucun groupe de wallets à signaux multiples détecté dans les données lues." });
  f2.push({ level: "INDICE", text: "Hypothèses de coordination: DÉSACTIVÉES. Ce rapport décrit des liens observés et des mesures, il n'affirme aucune coordination." });
  synthFund.push(inf.status === "ok" ? { level: "INDICE", text: `${r.cluster.groups.length} groupe(s) de wallets décrit(s), ${r.cluster.groups.filter((g) => g.significant).length} significatif(s) après ajustement (association financement ↔ comportement, jamais une intention).` } : { level: "INCONNU", text: `Groupes de wallets: test non exécutable (${inf.reason ?? inf.status}); les groupes sont décrits sans p-value.` });
  if (F.creatorLinks.length) synthFund.push({ level: "FAIT", text: `${new Set(F.creatorLinks.map((l) => l.wallet)).size} wallet(s) de la cohorte ont été financés par le créateur ou un de ses financeurs.` });
  for (const n of F.notes) if (!u2.includes(n)) u2.push(n);
  const funding = section("Financements et wallets liés", {
    status: F.wallets.length === 0 ? "unknown" : F.unknownCount === 0 && F.notTraced.length === 0 ? "ok" : "partial",
    data: { traced: F.wallets.length, known: F.knownCount, unknown: F.unknownCount, notTraced: F.notTraced.length, sharedSources: F.shared.slice(0, 20).map((s) => ({ source: s.source, hop: s.hop, wallets: s.wallets, discriminating: s.discriminating, entity: s.entity?.label ?? null, probableService: s.probableService, signatures: s.signatures.slice(0, 10) })), creatorChain: F.creatorChain, creatorLinks: F.creatorLinks.slice(0, 20).map((l) => ({ wallet: l.wallet, kind: l.kind, source: l.source, signature: l.signature, slot: l.slot })), groups: r.cluster.groups.slice(0, 20).map((g) => ({ id: g.id, wallets: g.wallets, families: g.families, strength: g.strength, inference: g.inference, adjustedP: g.adjustedP, significant: g.significant, hypothesisEligible: false })), inference: { status: inf.status, reason: inf.reason, knownWallets: inf.knownWallets, permutations: inf.permutations, method: inf.method }, hops: a.mode.launch.hops, synthesis: synthFund },
    findings: f2,
    unknowns: u2,
    limits: [`${a.mode.launch.cohortWallets} wallets et ${a.mode.launch.hops} saut(s) au plus (mode ${a.mode.name}); ${a.mode.launch.walletSignaturePages} page(s) de signatures et ${a.mode.launch.walletTransactions} plus anciennes transactions lues par wallet`, "seuls les virements SOL système sont vus; les dépôts via jetons enveloppés ou intermédiaires ne le sont pas"],
  });

  // repetitive volume
  const W = r.wash;
  const f3: Finding[] = [];
  const synthRep: Finding[] = [];
  if (W.swaps === 0) {
    f3.push({ level: "INCONNU", text: "Aucun swap décodé dans les transactions lues: volume répétitif non évaluable." });
  } else {
    f3.push({ level: "FAIT", text: `${W.swaps} swap(s) lus, ${W.distinctTraders} wallet(s) distinct(s) jugés; les 5 plus gros wallets font ${pct(W.top5VolumeShare)} du volume jugé${W.creatorVolumeShare !== null ? `; le wallet associé au déploiement ${pct(W.creatorVolumeShare)}` : ""}.` });
    f3.push({ level: "INDICE", text: `Aller-retours (achat puis vente du même wallet en ≤ 10 min): ${pct(W.roundTripShare)} du volume jugé. Mesure descriptive, sans test: acheter puis vendre est un comportement ordinaire.` });
    if (W.motifWallets.length) f3.push({ level: "INDICE", text: `${W.motifWallets.length} wallet(s) répètent des aller-retours équilibrés (≥ 5 cycles, totaux achetés/vendus à ≤ 2 %), soit ${pct(W.motifVolumeShare)} du volume jugé: ${W.motifWallets.slice(0, 3).map((m) => `${short(m.wallet)} (${m.cycles} cycles)`).join(", ")}. Motif identique pour un teneur de marché, un bot d'arbitrage ou un volume artificiel; ce rapport ne tranche pas.`, anchors: W.roundTrips.filter((x) => W.motifWallets.some((m) => m.wallet === x.wallet)).slice(0, 3).flatMap((x) => [x.buySignature, x.sellSignature]) });
    if (W.cadence.some((c) => c.metronomic)) f3.push({ level: "INDICE", text: `${W.cadence.filter((c) => c.metronomic).length} wallet(s) à tailles et intervalles très réguliers.` });
    if (W.transferCycles.length) f3.push({ level: "FAIT", text: `${W.transferCycles.length} cycle(s) de transferts du token entre wallets (A→B→A).` });
    for (const fl of W.flags) if (!fl.includes("motif descriptif") && !fl.includes("répétent")) f3.push({ level: "INDICE", text: `Repérage descriptif: ${fl}.` });
    synthRep.push({ level: "INDICE", text: `Volume lu: ${pct(W.roundTripShare)} d'aller-retours rapides${W.motifWallets.length ? `, dont ${W.motifWallets.length} wallet(s) au motif d'aller-retours équilibrés répétés (${pct(W.motifVolumeShare)} du volume)` : ""}; mesures descriptives, sans verdict.` });
  }
  const repetitive = section("Transactions répétitives", {
    status: W.swaps === 0 ? "unknown" : r.scopeLimited || !ctx.launchReached ? "partial" : "ok",
    data: { swaps: W.swaps, distinctTraders: W.distinctTraders, roundTripShare: W.roundTripShare, motifWallets: W.motifWallets.map((m) => ({ wallet: m.wallet, cycles: m.cycles, imbalance: m.imbalance })), motifVolumeShare: W.motifVolumeShare, top5VolumeShare: W.top5VolumeShare, creatorVolumeShare: W.creatorVolumeShare, metronomicWallets: W.cadence.filter((c) => c.metronomic).length, transferCycles: W.transferCycles.length, flags: W.flags, counterExplanations: W.counterExplanations, synthesis: synthRep },
    findings: f3,
    unknowns: r.scopeLimited ? ["activité postérieure à la fenêtre lue (volume, ventes, nouveaux acheteurs)"] : [],
    limits: [scope, ...W.notes.filter((n) => !n.includes("exclus")).slice(0, 2)],
  });
  const gapUnknowns = r.scopeLimited || !ctx.launchReached ? ["lecture limitée aux plus anciennes transactions du mint"] : [];
  return { firstBuyers, funding, repetitive, evidenceUnknowns: gapUnknowns };
}
