/**
 * Network side of wallet intelligence (read-only RPC). Budgeted: the public
 * RPC serves ~1 getTransaction per second, so every step has a cap and every
 * cap that is hit is reported instead of papered over.
 */

import { findFunder } from "../onchain/collect.ts";
import type { ParsedTransaction, SignatureInfo, SolanaRpc } from "../onchain/rpc.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import { decodeTrade, ownersTouching } from "./trades.ts";
import type { Trade } from "./trades.ts";
import type { TokenScan, WalletFacts } from "./types.ts";

export type WalletRpc = Pick<SolanaRpc, "url" | "getSignatures" | "getTransaction">;

/** Shared cap on history transactions for one run. */
export class HistoryBudget {
  remaining: number;
  constructor(n: number) {
    this.remaining = n;
  }
  take(n: number): boolean {
    if (n > this.remaining) return false;
    this.remaining -= n;
    return true;
  }
}

function isSigner(tx: ParsedTransaction, address: string): boolean {
  return tx.transaction.message.accountKeys.some((k) => k.pubkey === address && k.signer);
}

/** Trades on `mint` in one transaction. Only signers can be traders: pools and curves (PDAs) never sign. */
export function tradesInTx(tx: ParsedTransaction, mint: string): { trades: Trade[]; undecodable: number } {
  const trades: Trade[] = [];
  let undecodable = 0;
  for (const owner of ownersTouching(tx, mint)) {
    if (!isSigner(tx, owner)) continue;
    const r = decodeTrade(tx, owner, mint);
    if (r.ok) trades.push(r.trade);
    else if (r.reason !== "no_change") undecodable++;
  }
  return { trades, undecodable };
}

async function pageSignatures(rpc: WalletRpc, address: string, maxPages: number): Promise<{ sigs: SignatureInfo[]; complete: boolean }> {
  const sigs: SignatureInfo[] = [];
  let before: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const page = await rpc.getSignatures(address, 1000, before);
    sigs.push(...page);
    if (page.length < 1000) return { sigs, complete: true };
    before = page[page.length - 1].signature;
  }
  return { sigs, complete: false };
}

export async function collectTokenScan(
  rpc: WalletRpc,
  mint: string,
  supply: number | null,
  solUsd: number | null,
  c: WalletConfig = WALLET_CONFIG,
): Promise<TokenScan> {
  const { sigs, complete } = await pageSignatures(rpc, mint, c.discovery.maxMintSignaturePages);
  const ok = sigs.filter((s) => !s.err);
  const oldest = complete && sigs.length ? sigs[sigs.length - 1] : null;
  const earlySigs = complete ? [...ok].reverse().slice(0, c.discovery.earlyTransactions) : [];
  const earlySet = new Set(earlySigs.map((s) => s.signature));
  const recentSigs = ok.filter((s) => !earlySet.has(s.signature)).slice(0, c.discovery.recentTransactions);

  let fetched = 0;
  let failed = 0;
  let undecodable = 0;
  const decode = async (list: SignatureInfo[]): Promise<Trade[]> => {
    const out: Trade[] = [];
    for (const s of list) {
      let tx: ParsedTransaction | null = null;
      try {
        tx = await rpc.getTransaction(s.signature);
      } catch {
        failed++;
        continue;
      }
      if (!tx) {
        failed++;
        continue;
      }
      fetched++;
      const r = tradesInTx(tx, mint);
      out.push(...r.trades);
      undecodable += r.undecodable;
    }
    return out;
  };
  const earlyTrades = await decode(earlySigs);
  const recentTrades = await decode(recentSigs);

  return {
    mint,
    launch: oldest ? { time: oldest.blockTime ? oldest.blockTime * 1000 : null, slot: oldest.slot ?? null, signature: oldest.signature } : null,
    signaturesScanned: sigs.length,
    launchReachable: complete,
    transactionsFetched: fetched,
    transactionsFailed: failed,
    undecodable,
    earlyTrades,
    recentTrades,
    supply,
    solUsd,
  };
}

export async function collectWalletFacts(rpc: WalletRpc, address: string, budget: HistoryBudget, c: WalletConfig = WALLET_CONFIG): Promise<WalletFacts> {
  const { sigs, complete } = await pageSignatures(rpc, address, c.history.signaturePages);
  const facts: WalletFacts = {
    address,
    signatureCount: sigs.length,
    historyComplete: complete,
    firstSeen: null,
    funder: null,
    fundingSignature: null,
    fundingTime: null,
    funderSignatureCount: null,
    signatures: sigs.slice(0, 1000).map((s) => s.signature),
    trades: null,
    historyNote: "",
    undecodableTxs: 0,
  };
  if (!complete) {
    facts.historyNote = `≥ ${sigs.length.toLocaleString("en-US")} transactions : historique trop long pour le RPC gratuit (≈ 1 transaction/s)`;
    return facts;
  }
  if (sigs.length === 0) {
    facts.historyNote = "aucune transaction";
    return facts;
  }
  const oldest = sigs[sigs.length - 1];
  facts.firstSeen = oldest.blockTime ? oldest.blockTime * 1000 : null;
  const first = await rpc.getTransaction(oldest.signature);
  if (first) {
    facts.funder = findFunder(first, address, 0.01);
    if (facts.funder) {
      facts.fundingSignature = oldest.signature;
      facts.fundingTime = facts.firstSeen;
    }
  }

  const ok = sigs.filter((s) => !s.err);
  if (sigs.length > c.history.maxSignaturesForFullHistory) {
    facts.historyNote = `${sigs.length} transactions > seuil de reconstruction complète (${c.history.maxSignaturesForFullHistory})`;
    return facts;
  }
  if (!budget.take(ok.length)) {
    facts.historyNote = "budget de transactions de la session épuisé";
    return facts;
  }
  const trades: Trade[] = [];
  for (const s of ok) {
    const tx = await rpc.getTransaction(s.signature);
    if (!tx) {
      facts.historyNote = `transaction ${s.signature.slice(0, 8)}… introuvable : historique incomplet`;
      return facts;
    }
    // Every token this wallet traded in the transaction.
    const mints = new Set((tx.meta?.postTokenBalances ?? []).concat(tx.meta?.preTokenBalances ?? []).filter((b) => b.owner === address).map((b) => b.mint));
    let decoded = false;
    for (const m of mints) {
      const r = decodeTrade(tx, address, m);
      if (r.ok) {
        trades.push(r.trade);
        decoded = true;
      }
    }
    if (!decoded && mints.size) facts.undecodableTxs++;
  }
  facts.trades = trades;
  facts.historyNote = `historique complet : ${ok.length} transactions réussies, ${trades.length} trades décodés`;
  return facts;
}

/** Signature count (one page) for funders shared by several wallets: a full page suggests an exchange or service. */
export async function checkFunders(rpc: WalletRpc, facts: WalletFacts[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const f of facts) if (f.funder) counts.set(f.funder, (counts.get(f.funder) ?? 0) + 1);
  for (const [funder, n] of counts) {
    if (n < 2) continue;
    let count: number | null = null;
    try {
      count = (await rpc.getSignatures(funder, 1000)).length;
    } catch {
      count = null;
    }
    for (const f of facts) if (f.funder === funder) f.funderSignatureCount = count;
  }
}
