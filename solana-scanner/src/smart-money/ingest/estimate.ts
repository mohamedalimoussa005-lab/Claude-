/**
 * Dry-run estimator: how many requests and Helius credits an ingestion can
 * cost, WITHOUT sending anything. Worst case on purpose: every wallet is
 * assumed to be longer than the cap and nothing is in the cache.
 *
 * Scenarios follow how the existing providers behave:
 *  - helius_free: getTransactionsForAddress is refused (Developer plan+ only) after one probe; the provider falls back to
 *    getSignaturesForAddress + enhanced decoding (100 credits per request of up to 100 signatures).
 *  - helius_developer: getTransactionsForAddress, 10 credits per 100 full transactions.
 *  - helius_rpc: the same free plan through authenticated getSignaturesForAddress + getTransaction (1 credit each, complete
 *    signer information, so rent can be attributed).
 *  - public_rpc: free endpoint, 0 Helius credits, one getTransaction per transaction, ~1 transaction per second.
 */

import { CREDIT_COST, FREE_PLAN } from "./costModel.ts";

export type Scenario = "helius_free" | "helius_developer" | "helius_rpc" | "public_rpc";

export interface EstimateInput {
  wallets: number;
  /** Cap per wallet (transactions). */
  maxTransactions: number;
  pageLimit: number;
  maxPages: number;
}

export interface ScenarioEstimate {
  scenario: Scenario;
  calls: number;
  credits: number;
  /** Rough duration, seconds. */
  seconds: number;
  /** Share of the free monthly allowance. */
  shareOfFreeAllowance: number;
  note: string;
}

export interface Estimate {
  input: EstimateInput;
  pagesPerWallet: number;
  txPerWallet: number;
  scenarios: ScenarioEstimate[];
  /** The most expensive scenario that can happen with the default Helius provider (GTFA probe, then enhanced fallback). */
  worstHelius: ScenarioEstimate;
}

/** The scenario that matches a provider choice. */
export function scenarioFor(e: Estimate, provider: "auto" | "helius" | "helius-rpc" | "public", heliusKey: boolean): ScenarioEstimate {
  const by = (s: Scenario) => e.scenarios.find((x) => x.scenario === s)!;
  if (provider === "public" || !heliusKey) return by("public_rpc");
  return provider === "helius-rpc" ? by("helius_rpc") : e.worstHelius;
}

export function estimateIngest(i: EstimateInput): Estimate {
  const txPerWallet = Math.max(0, i.maxTransactions);
  const pageLimit = Math.max(1, i.pageLimit);
  const pagesPerWallet = Math.min(i.maxPages, Math.ceil(txPerWallet / pageLimit));
  const lastPage = txPerWallet - (pagesPerWallet - 1) * pageLimit;
  const pageSizes = Array.from({ length: pagesPerWallet }, (_, p) => (p === pagesPerWallet - 1 ? Math.min(pageLimit, lastPage) : pageLimit));
  const cappedTx = pageSizes.reduce((a, b) => a + b, 0);
  const share = (c: number) => c / FREE_PLAN.monthlyCredits;
  const probe = { calls: 1, credits: CREDIT_COST.gtfaPer100 * Math.ceil(Math.min(pageLimit, 100) / 100) };

  const free = {
    calls: probe.calls + i.wallets * pageSizes.reduce((a, n) => a + 1 + Math.ceil(n / 100), 0),
    credits: probe.credits + i.wallets * pageSizes.reduce((a, n) => a + CREDIT_COST.standardRpc + CREDIT_COST.enhancedTransactions * Math.ceil(n / 100), 0),
  };
  const dev = {
    calls: i.wallets * pagesPerWallet,
    credits: i.wallets * pageSizes.reduce((a, n) => a + CREDIT_COST.gtfaPer100 * Math.ceil(n / 100), 0),
  };
  const rpc = { calls: i.wallets * (pagesPerWallet + cappedTx), credits: i.wallets * (pagesPerWallet + cappedTx) * CREDIT_COST.standardRpc };
  const pub = { calls: i.wallets * (pagesPerWallet + cappedTx), credits: 0 };

  const scenarios: ScenarioEstimate[] = [
    { scenario: "helius_free", ...free, seconds: Math.ceil(free.calls / FREE_PLAN.enhancedRequestsPerSecond), shareOfFreeAllowance: share(free.credits), note: "getTransactionsForAddress refusé (plan Free) → repli signatures + décodage enrichi (≈1 crédit par transaction)" },
    { scenario: "helius_developer", ...dev, seconds: Math.ceil(dev.calls / FREE_PLAN.enhancedRequestsPerSecond), shareOfFreeAllowance: share(dev.credits), note: "getTransactionsForAddress (plan Developer ou plus : payant, non requis)" },
    { scenario: "helius_rpc", ...rpc, seconds: Math.ceil(rpc.calls / 4), shareOfFreeAllowance: share(rpc.credits), note: "plan Free via RPC authentifié : ≈1 crédit par transaction + 1 par page, signataires complets (rent attribuable) — recommandé pour un essai" },
    { scenario: "public_rpc", ...pub, seconds: i.wallets * cappedTx, shareOfFreeAllowance: 0, note: "RPC public gratuit : 0 crédit Helius, environ 1 transaction par seconde" },
  ];
  return { input: i, pagesPerWallet, txPerWallet: cappedTx, scenarios, worstHelius: free.credits >= dev.credits ? scenarios[0] : scenarios[1] };
}

export function formatEstimate(e: Estimate): string {
  const L = [`Estimation (pire cas, sans cache) : ${e.input.wallets} wallet(s) × ${e.txPerWallet} transactions max, pages de ${e.input.pageLimit}, ${e.pagesPerWallet} page(s) max par wallet`];
  for (const s of e.scenarios) L.push(`  ${s.scenario.padEnd(17)} ${String(s.calls).padStart(5)} appels · ${String(s.credits).padStart(6)} crédits Helius (${(s.shareOfFreeAllowance * 100).toFixed(3)} % du quota gratuit mensuel) · ~${s.seconds} s\n    ${s.note}`);
  L.push("Les crédits sont une estimation d'après les tarifs documentés par Helius ; le compte réel fait foi.");
  return L.join("\n");
}
