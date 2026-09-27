/**
 * Step 4.2: wallet facts from the history layer (WalletHistoryService),
 * injected — never built here, never from UI code.
 *
 * - QUICK first (recent activity + origin). DEEP only for a shortlisted
 *   wallet whose history is incomplete, that isn't clearly a bot, whose
 *   history can fit the DEEP budget, and while the per-token DEEP budget lasts.
 * - Trades (and so positions, realized PnL, win rate) exist only when the
 *   history is COMPLETE — whatever its length. No 150-transaction rule.
 * - UNKNOWN stays UNKNOWN: an unknown origin gives no age, an unknown funder
 *   gives no funding link; neither becomes a negative signal.
 * - Token transfers are kept (creator distribution, relationships) and are
 *   never trades.
 */

import { classifyForWallet, toTrade } from "../history/classify.ts";
import type { HistoryCache } from "../history/cache.ts";
import type { DeepHistory, DeepOptions, QuickHistory } from "../history/service.ts";
import type { HistoryTx } from "../history/types.ts";
import { detectBotSignals } from "./botSignals.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import type { Trade } from "./trades.ts";
import type { HistoryExtras, TokenTransfer, WalletFacts } from "./types.ts";

/** What step 4 needs from WalletHistoryService (injected). */
export interface HistorySource {
  readonly cache: HistoryCache;
  quick(address: string): Promise<QuickHistory>;
  getFullHistory(address: string, opts?: DeepOptions): Promise<DeepHistory>;
}

/** DEEP runs left for the current token. */
export class DeepBudget {
  remaining: number;
  constructor(n: number) {
    this.remaining = n;
  }
}

/** Funder from a wallet's first transaction: the account that paid the SOL it received. */
export function historyFunder(tx: HistoryTx, wallet: string, minFundingSol: number): string | null {
  if ((tx.lamportDeltas[wallet] ?? 0) < minFundingSol * 1e9) return null;
  let best: string | null = null;
  let bestDelta = 0;
  for (const [account, delta] of Object.entries(tx.lamportDeltas)) {
    if (account === wallet) continue;
    const d = delta + (account === tx.feePayer ? tx.fee : 0);
    if (d < bestDelta) {
      bestDelta = d;
      best = account;
    }
  }
  return best;
}

/** Token movements of `wallet` classified TRANSFER, with the other side(s). */
export function tokenTransfers(txs: HistoryTx[], wallet: string): TokenTransfer[] {
  const out: TokenTransfer[] = [];
  for (const tx of txs) {
    const c = classifyForWallet(tx, wallet);
    if (c.kind !== "TRANSFER" || !c.mint || c.tokenAmount === null) continue;
    const mine = BigInt(tx.tokenDeltas[wallet][c.mint].raw);
    const counterparties = Object.entries(tx.tokenDeltas)
      .filter(([owner, m]) => owner !== wallet && m[c.mint!] && BigInt(m[c.mint!].raw) * mine < 0n)
      .map(([owner]) => owner);
    out.push({ signature: tx.signature, time: tx.time, mint: c.mint, direction: mine > 0n ? "in" : "out", amount: c.tokenAmount, counterparties });
  }
  return out;
}

function tradesOf(txs: HistoryTx[], wallet: string): { trades: Trade[]; undecodable: number } {
  const trades: Trade[] = [];
  let undecodable = 0;
  for (const tx of txs) {
    const t = toTrade(tx, wallet);
    if (t) trades.push(t);
    else if (classifyForWallet(tx, wallet).kind === "UNKNOWN" && Object.keys(tx.tokenDeltas[wallet] ?? {}).length) undecodable++;
  }
  return { trades: trades.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)), undecodable };
}

export async function collectWalletFactsFromHistory(
  source: HistorySource,
  address: string,
  opts: { deepAllowed: boolean; budget: DeepBudget },
  c: WalletConfig = WALLET_CONFIG,
): Promise<WalletFacts> {
  const h = c.historyLayer;
  const q = await source.quick(address);
  const byId = new Map<string, HistoryTx>();
  for (const tx of [...q.recent.page.txs, ...(q.originPage?.txs ?? [])]) byId.set(tx.signature, tx);
  const bot = detectBotSignals(q.recent.page.txs, address, c);
  const trace: HistoryExtras["providerTrace"] = [...q.trace];

  let complete = q.recent.complete;
  let completeness: HistoryExtras["completeness"] = complete ? "recent_page_covers_history" : "incomplete";
  const deep: HistoryExtras["deep"] = { attempted: false, skippedReason: null, stopReason: null };
  if (!complete) {
    const tooLong = q.origin.reason === "budget_exhausted" && q.origin.signaturesScanned >= h.deepMaxTransactions;
    deep.skippedReason = !opts.deepAllowed
      ? "deep_disabled"
      : bot.botLike
        ? "bot_like"
        : tooLong
          ? "history_exceeds_deep_budget"
          : opts.budget.remaining <= 0
            ? "deep_budget_exhausted"
            : null;
    if (deep.skippedReason === null) {
      opts.budget.remaining--;
      deep.attempted = true;
      const d = await source.getFullHistory(address, { maxPages: h.deepMaxPages, maxTransactions: h.deepMaxTransactions });
      deep.stopReason = d.stopReason;
      trace.push({ phase: "deep", steps: d.trace });
      for (const tx of d.txs) byId.set(tx.signature, tx);
      if (d.complete) {
        complete = true;
        completeness = "deep_complete";
      }
    }
  } else {
    deep.skippedReason = "complete_from_quick";
  }

  const txs = [...byId.values()].filter((t) => !t.failed);
  const unknowns: string[] = [];
  const origin = q.origin;
  let firstSeen: number | null = null;
  let funder: string | null = null;
  let fundingSignature: string | null = null;
  let fundingTime: number | null = null;
  if (origin.found) {
    firstSeen = origin.firstSeen;
    const first = (origin.signature && (byId.get(origin.signature) ?? source.cache.getTx(origin.signature))) || null;
    if (first) {
      funder = historyFunder(first, address, h.minFundingSol);
      if (funder) {
        fundingSignature = first.signature;
        fundingTime = first.time;
      }
    }
    if (!funder) unknowns.push("Financement initial : UNKNOWN (première transaction sans apport de SOL identifiable).");
  } else {
    unknowns.push(`Âge du wallet : UNKNOWN (origine non trouvée : ${origin.reason}).`);
    unknowns.push("Financement initial : UNKNOWN (première transaction non atteinte).");
  }

  const listed = q.recent.stats.signaturesListed;
  const lowerBound = !complete;
  const signatureCount = complete ? txs.length : Math.max(txs.length, listed, origin.reason === "budget_exhausted" ? origin.signaturesScanned : 0);
  const { trades, undecodable } = complete ? tradesOf(txs, address) : { trades: null, undecodable: 0 };

  const historyNote = complete
    ? `historique complet (${completeness === "deep_complete" ? "DEEP" : "QUICK"}) : ${txs.length} transactions réussies, ${trades!.length} trades décodés`
    : `historique incomplet : ${txs.length} transactions récentes${lowerBound ? `, ≥ ${signatureCount.toLocaleString("en-US")} signatures` : ""}${deep.skippedReason ? ` (DEEP non lancé : ${deep.skippedReason})` : deep.stopReason ? ` (DEEP arrêté : ${deep.stopReason})` : ""}`;

  return {
    address,
    signatureCount,
    historyComplete: complete,
    firstSeen,
    funder,
    fundingSignature,
    fundingTime,
    funderSignatureCount: null,
    signatures: [...txs].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 1000).map((t) => t.signature),
    trades,
    historyNote,
    undecodableTxs: undecodable,
    history: {
      mode: deep.attempted ? "deep" : "quick",
      completeness,
      signatureCountIsLowerBound: lowerBound,
      origin,
      bot,
      transfers: tokenTransfers(txs, address),
      deep,
      providerTrace: trace,
      unknowns,
    },
  };
}

export interface CreatorDistribution {
  mint: string;
  /** Token transfers out of the creator (not sells). */
  transfers: number;
  recipients: string[];
  /** UI units, and % of supply when known. */
  tokenAmount: number;
  pctSupply: number | null;
  /** Recipients that are also tracked buyers. */
  recipientsTracked: string[];
  /** Recipients checked (QUICK) that later SOLD the token, from balances. */
  recipientSells: { address: string; sells: number; solReceived: number }[];
  recipientsChecked: number;
}

/** Creator → many wallets by transfer instead of selling (DOGRILLA benchmark). */
export async function creatorDistribution(
  source: HistorySource,
  creatorFacts: WalletFacts,
  mint: string,
  supply: number | null,
  tracked: string[],
  c: WalletConfig = WALLET_CONFIG,
): Promise<CreatorDistribution | null> {
  const out = (creatorFacts.history?.transfers ?? []).filter((t) => t.mint === mint && t.direction === "out");
  if (!out.length) return null;
  const recipients = [...new Set(out.flatMap((t) => t.counterparties))];
  const tokenAmount = out.reduce((s, t) => s + t.amount, 0);
  const recipientSells: CreatorDistribution["recipientSells"] = [];
  const checked = recipients.slice(0, c.historyLayer.distributionRecipientsChecked);
  for (const r of checked) {
    let q: QuickHistory;
    try {
      q = await source.quick(r);
    } catch {
      continue;
    }
    const sells = [...q.recent.page.txs, ...(q.originPage?.txs ?? [])].map((tx) => toTrade(tx, r)).filter((t): t is Trade => !!t && t.mint === mint && t.side === "sell");
    if (sells.length) recipientSells.push({ address: r, sells: sells.length, solReceived: sells.reduce((s, t) => s + t.sol, 0) });
  }
  return {
    mint,
    transfers: out.length,
    recipients,
    tokenAmount,
    pctSupply: supply ? (tokenAmount / supply) * 100 : null,
    recipientsTracked: recipients.filter((r) => tracked.includes(r)),
    recipientSells,
    recipientsChecked: checked.length,
  };
}

/** Per-token wallet stage on the history layer: shortlisted wallets, creator, distribution. */
export async function collectTokenWalletsFromHistory(
  source: HistorySource,
  o: { picks: string[]; creator: string | null; mint: string; supply: number | null; deepAllowed: boolean },
  c: WalletConfig = WALLET_CONFIG,
): Promise<{ facts: WalletFacts[]; creatorFacts: WalletFacts | null; distribution: CreatorDistribution | null; deepRuns: number }> {
  const budget = new DeepBudget(c.historyLayer.deepMaxWalletsPerToken);
  const facts: WalletFacts[] = [];
  for (const a of o.picks) facts.push(await collectWalletFactsFromHistory(source, a, { deepAllowed: o.deepAllowed, budget }, c));
  let creatorFacts: WalletFacts | null = null;
  let distribution: CreatorDistribution | null = null;
  if (o.creator) {
    try {
      // QUICK only for the creator: its funding and its token transfers (distribution).
      creatorFacts = await collectWalletFactsFromHistory(source, o.creator, { deepAllowed: false, budget }, c);
      distribution = await creatorDistribution(source, creatorFacts, o.mint, o.supply, o.picks, c);
    } catch {
      creatorFacts = null;
    }
  }
  return { facts, creatorFacts, distribution, deepRuns: c.historyLayer.deepMaxWalletsPerToken - budget.remaining };
}
