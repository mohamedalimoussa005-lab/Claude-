/**
 * RPC side of wallet intelligence (read-only): the token scan that discovers
 * buyers, and the activity check of shared funders. Wallet histories come from
 * the history layer (historyFacts.ts), never from here. Budgeted: every cap
 * that is hit is reported instead of papered over.
 */

import type { ParsedTransaction, SignatureInfo, SolanaRpc } from "../onchain/rpc.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import { decodeTrade, ownersTouching } from "./trades.ts";
import type { Trade } from "./trades.ts";
import type { TokenScan, WalletFacts } from "./types.ts";

export type WalletRpc = Pick<SolanaRpc, "url" | "getSignatures" | "getTransaction">;

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
    let page: SignatureInfo[];
    try {
      page = await rpc.getSignatures(address, 1000, before);
    } catch (e) {
      // Nothing listed yet: the caller decides. Pages already listed are kept (history marked incomplete).
      if (!sigs.length) throw e;
      return { sigs, complete: false };
    }
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

/**
 * Signature count (one page) of funders shared by several wallets — a full
 * page suggests an exchange or service — and of `alsoCheck` (the deployment
 * wallet's funder) when at least one wallet shares it. One request per funder,
 * never per wallet; returns the counts (null = check failed, UNKNOWN).
 */
export async function checkFunders(rpc: WalletRpc, facts: WalletFacts[], onFailure?: (e: unknown) => void, o: { alsoCheck?: string | null } = {}): Promise<Map<string, number | null>> {
  const counts = new Map<string, number>();
  for (const f of facts) if (f.funder) counts.set(f.funder, (counts.get(f.funder) ?? 0) + 1);
  const out = new Map<string, number | null>();
  for (const [funder, n] of counts) {
    if (n < 2 && funder !== o.alsoCheck) continue;
    let count: number | null = null;
    try {
      count = (await rpc.getSignatures(funder, 1000)).length;
    } catch (e) {
      count = null;
      onFailure?.(e);
    }
    out.set(funder, count);
    for (const f of facts) if (f.funder === funder) f.funderSignatureCount = count;
  }
  return out;
}
