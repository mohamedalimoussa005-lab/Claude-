import type { HistoryTx } from "../../history/types.ts";
import type { WalletReport } from "../ingest/report.ts";
import type { Reconciliation } from "./types.ts";

/**
 * listed = retrieved + failed + missing, and (on the RPC path) calls = pages + one getTransaction per retrieved or missing
 * signature. Failed signatures are flagged `err` by the listing and are never requested, so if the budget matches the
 * second identity the failed ones cost nothing and cannot be in the analysis.
 */
export function reconcile(report: WalletReport | null, cached: HistoryTx[]): Reconciliation {
  const failedInCache = cached.filter((t) => t.failed).length;
  if (!report) {
    return {
      status: "impossible",
      reason: "pas de rapport enregistré : le cache ne contient ni les signatures échouées ni les compteurs de la collecte",
      rows: [{ label: "transactions en cache", value: cached.length }],
      gap: null,
      explainedBy: { failed: null, missing: null },
      gapExplained: null,
      budget: null,
      failedInCache,
      verdict: "Réconciliation impossible sans rapport enregistré (relancez la collecte avec --save, ou fournissez le snapshot wallet-*.json).",
    };
  }
  const h = report.history;
  const retrieved = h.downloaded + h.fromCache;
  const gap = h.listed - retrieved;
  const failed = h.failedSkipped;
  const explained = failed === null ? null : gap === failed + h.missing;
  const rows = [
    { label: "listées par le fournisseur", value: h.listed },
    { label: "téléchargées", value: h.downloaded },
    { label: "depuis le cache", value: h.fromCache },
    { label: "récupérées (téléchargées + cache)", value: retrieved },
    { label: "échouées (ignorées)", value: failed },
    { label: "introuvables", value: h.missing },
    { label: "retenues pour l'analyse", value: report.transactions.used },
    { label: "pages", value: h.pages },
    { label: "appels fournisseur", value: h.providerCalls },
  ];
  let budget: Reconciliation["budget"] = null;
  const calls = report.budget?.calls ?? null;
  const rpcPath = (report.transport ?? "").includes("authenticated_rpc") || h.providers.includes("public_rpc");
  if (calls !== null && rpcPath && failed !== null) {
    const notRequested = h.pages + h.downloaded + h.missing; // listings + one getTransaction per non-failed signature
    const requested = notRequested + failed;
    budget = {
      reportedCalls: calls,
      expectedIfFailedNotRequested: notRequested,
      expectedIfFailedRequested: requested,
      verdict: calls === notRequested ? "failed_not_requested" : calls === requested ? "failed_requested" : "unexplained",
    };
  } else if (calls !== null) {
    budget = { reportedCalls: calls, expectedIfFailedNotRequested: null, expectedIfFailedRequested: null, verdict: "not_applicable" };
  }
  let verdict: string;
  if (failed === null) verdict = "Le fournisseur filtre les transactions échouées côté serveur : leur nombre est inconnu, l'écart ne peut pas être expliqué.";
  else if (explained) {
    verdict = `Réconcilié : ${h.listed} listées = ${retrieved} récupérées + ${failed} échouées + ${h.missing} introuvables.`;
    if (budget?.verdict === "failed_not_requested") verdict += ` Preuve par le budget : ${budget.reportedCalls} appels = ${h.pages} pages + ${h.downloaded} transactions → les ${failed} échouées n'ont jamais été demandées.`;
    else if (budget?.verdict === "failed_requested") verdict += ` Attention : le budget (${budget.reportedCalls}) correspond à des échouées réellement demandées.`;
    else if (budget?.verdict === "unexplained") verdict += ` Le budget (${budget.reportedCalls}) ne correspond à aucun des deux scénarios (${budget.expectedIfFailedNotRequested} / ${budget.expectedIfFailedRequested}) : tentatives répétées ou autre transport.`;
  } else verdict = `ÉCART NON EXPLIQUÉ : ${gap} listées non récupérées, mais ${failed} échouées + ${h.missing} introuvables.`;
  if (failedInCache > 0) verdict += ` ALERTE : ${failedInCache} transaction(s) échouée(s) présentes dans le cache.`;
  return { status: failed === null ? "partial" : "ok", reason: failed === null ? "échouées filtrées côté serveur" : undefined, rows, gap, explainedBy: { failed, missing: h.missing }, gapExplained: explained, budget, failedInCache, verdict };
}
