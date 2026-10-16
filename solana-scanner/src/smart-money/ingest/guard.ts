/**
 * Gate in front of every live (network) run. All of these must hold, or
 * nothing is sent. The limits marked CODE are not overridable from the
 * command line.
 */

import { estimateIngest, scenarioFor } from "./estimate.ts";
import type { Estimate } from "./estimate.ts";

/** CODE: live trials cover at most this many wallets. */
export const LIVE_MAX_WALLETS = 3;
/** CODE: no live budget may exceed this many estimated credits (0.5 % of the free monthly allowance). */
export const LIVE_MAX_CREDITS = 5_000;
export const LIVE_MAX_CALLS = 2_000;
/** CODE: bounds the cost of the getTransactionsForAddress probe and of a page. */
export const LIVE_MAX_PAGE_LIMIT = 100;
export const LIVE_MAX_TX_PER_WALLET = 1_000;

export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** auto: Helius (getTransactionsForAddress probe, enhanced fallback) then public RPC · helius: same, no public fallback ·
 *  helius-rpc: authenticated RPC getTransaction (recommended on the Free plan) · public: free public RPC only. */
export type ProviderChoice = "auto" | "helius" | "helius-rpc" | "public";

export interface LiveRequest {
  wallets: string[];
  provider: ProviderChoice;
  maxCredits: number | null;
  maxCalls: number | null;
  maxTransactions: number;
  maxPages: number;
  pageLimit: number;
  /** The user confirmed the Helius account is on the Free plan with autoscaling OFF (we cannot check it). */
  ackNoAutoscale: boolean;
  heliusKeyPresent: boolean;
}

export interface LiveCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimate: Estimate;
}

export function checkLive(r: LiveRequest, env: Record<string, string | undefined>): LiveCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (env.SMART_MONEY_LIVE_OK !== "yes") errors.push("SMART_MONEY_LIVE_OK=yes absent de l'environnement (autorisation explicite requise)");
  if (r.wallets.length === 0) errors.push("aucun wallet");
  if (r.wallets.length > LIVE_MAX_WALLETS) errors.push(`au plus ${LIVE_MAX_WALLETS} wallets en essai live (reçu ${r.wallets.length})`);
  if (new Set(r.wallets).size !== r.wallets.length) errors.push("wallets en double");
  for (const w of r.wallets) if (!SOLANA_ADDRESS.test(w)) errors.push("adresse de wallet invalide");
  if (r.maxCredits === null || !(r.maxCredits > 0)) errors.push("--max-credits requis (budget explicite)");
  else if (r.maxCredits > LIVE_MAX_CREDITS) errors.push(`--max-credits ne peut pas dépasser ${LIVE_MAX_CREDITS}`);
  if (r.maxCalls === null || !(r.maxCalls > 0)) errors.push("--max-calls requis (budget explicite)");
  else if (r.maxCalls > LIVE_MAX_CALLS) errors.push(`--max-calls ne peut pas dépasser ${LIVE_MAX_CALLS}`);
  if (!r.ackNoAutoscale) errors.push("--ack-no-autoscale requis : confirmez que votre compte Helius est en plan Free, autoscaling désactivé (je ne peux pas le vérifier)");
  if (r.pageLimit > LIVE_MAX_PAGE_LIMIT) errors.push(`--page-limit ne peut pas dépasser ${LIVE_MAX_PAGE_LIMIT} en live`);
  if (r.maxTransactions > LIVE_MAX_TX_PER_WALLET) errors.push(`--max-tx ne peut pas dépasser ${LIVE_MAX_TX_PER_WALLET} par wallet en live`);
  if ((r.provider === "helius" || r.provider === "helius-rpc") && !r.heliusKeyPresent) errors.push(`--provider ${r.provider} demandé mais HELIUS_API_KEY est absente`);
  if (r.provider === "auto" && !r.heliusKeyPresent) warnings.push("HELIUS_API_KEY absente : RPC public uniquement (lent, gratuit)");

  const estimate = estimateIngest({ wallets: Math.max(1, r.wallets.length), maxTransactions: r.maxTransactions, pageLimit: r.pageLimit, maxPages: r.maxPages });
  const sc = scenarioFor(estimate, r.provider, r.heliusKeyPresent);
  const heliusUsed = r.provider !== "public" && r.heliusKeyPresent;
  if (heliusUsed && r.maxCredits !== null && sc.credits > r.maxCredits) warnings.push(`le pire cas (${sc.credits} crédits) dépasse le budget (${r.maxCredits}) : l'historique sera TRONQUÉ au budget, et déclaré tel`);
  if (r.maxCalls !== null && sc.calls > r.maxCalls) warnings.push(`le pire cas demande ${sc.calls} appels (budget ${r.maxCalls}) : historique TRONQUÉ au budget, et déclaré tel`);
  return { ok: errors.length === 0, errors, warnings, estimate };
}
