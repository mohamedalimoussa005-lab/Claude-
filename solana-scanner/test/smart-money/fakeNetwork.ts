/**
 * An offline stand-in for Helius and the public Solana RPC, backed by HistoryTx fixtures. It answers the exact requests the
 * existing providers send (getTransactionsForAddress, getSignaturesForAddress, getTransaction, POST /v0/transactions) and
 * records what was asked, so tests can count calls and credits without touching a network.
 */

import type { EnhancedTransaction } from "../../src/history/normalize.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import type { ParsedTransaction } from "../../src/onchain/rpc.ts";

export const KEY = "hk-FAKE-KEY-for-tests-0123456789";

export function toEnhanced(tx: HistoryTx): EnhancedTransaction {
  const accounts = new Set([...Object.keys(tx.lamportDeltas), ...Object.keys(tx.tokenDeltas)]);
  return {
    signature: tx.signature,
    slot: tx.slot,
    timestamp: tx.time === null ? null : Math.floor(tx.time / 1000),
    fee: tx.fee,
    feePayer: tx.feePayer ?? undefined,
    type: "SWAP",
    source: "FAKE",
    transactionError: tx.failed ? { err: 1 } : null,
    accountData: [...accounts].map((account) => ({
      account,
      nativeBalanceChange: tx.lamportDeltas[account] ?? 0,
      tokenBalanceChanges: Object.entries(tx.tokenDeltas[account] ?? {}).map(([mint, d]) => ({ userAccount: account, mint, rawTokenAmount: { tokenAmount: d.raw, decimals: d.decimals } })),
    })),
    instructions: tx.programIds.map((programId) => ({ programId, innerInstructions: [] })),
  };
}

export function toParsed(tx: HistoryTx): ParsedTransaction {
  const payer = tx.feePayer ?? tx.signers[0];
  const keys = [payer, ...tx.signers.filter((s) => s !== payer), ...Object.keys(tx.lamportDeltas).filter((a) => a !== payer && !tx.signers.includes(a)), ...Object.keys(tx.tokenDeltas).filter((a) => a !== payer && !tx.signers.includes(a) && !(a in tx.lamportDeltas))];
  const pre = keys.map((k) => 10e9 + Math.max(0, -(tx.lamportDeltas[k] ?? 0)));
  const post = keys.map((k, i) => pre[i] + (tx.lamportDeltas[k] ?? 0));
  const tokenBalances = (after: boolean) =>
    Object.entries(tx.tokenDeltas).flatMap(([owner, mints]) =>
      Object.entries(mints).map(([mint, d]) => {
        const raw = BigInt(d.raw);
        const before = 1_000_000_000_000n + (raw < 0n ? -raw : 0n);
        return { accountIndex: keys.indexOf(owner), mint, owner, uiTokenAmount: { amount: (after ? before + raw : before).toString(), decimals: d.decimals, uiAmount: null } };
      }),
    );
  return {
    slot: tx.slot ?? undefined,
    blockTime: tx.time === null ? null : Math.floor(tx.time / 1000),
    transaction: { signatures: [tx.signature], message: { accountKeys: keys.map((pubkey) => ({ pubkey, signer: pubkey === payer || tx.signers.includes(pubkey), writable: true })), instructions: tx.programIds.map((programId) => ({ programId })) } },
    meta: { err: tx.failed ? { err: 1 } : null, fee: tx.fee, preBalances: pre, postBalances: post, preTokenBalances: tokenBalances(false), postTokenBalances: tokenBalances(true) },
  };
}

export interface FakeOptions {
  /** Helius answers 401 to everything. */
  unauthorized?: boolean;
  /** Helius answers 200 to getTransactionsForAddress (Developer plan) with an empty page. */
  gtfaAllowed?: boolean;
  /** Public RPC host fails with HTTP 500. */
  publicDown?: boolean;
}

export interface Seen {
  host: string;
  kind: "gtfa" | "signatures" | "transaction" | "enhanced" | "other";
  url: string;
}

export function fakeNetwork(history: Record<string, HistoryTx[]>, o: FakeOptions = {}) {
  const seen: Seen[] = [];
  const all = new Map<string, HistoryTx>();
  const byWallet = new Map<string, HistoryTx[]>();
  for (const [w, txs] of Object.entries(history)) {
    const sorted = [...txs].sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0) || (a.signature < b.signature ? 1 : -1));
    byWallet.set(w, sorted);
    for (const t of sorted) all.set(t.signature, t);
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const body = JSON.parse(String(init?.body ?? "null"));
    const helius = u.host === "mainnet.helius-rpc.com";
    if (helius && o.unauthorized) {
      seen.push({ host: u.host, kind: "other", url });
      return json({ error: "unauthorized" }, 401);
    }
    if (!helius && o.publicDown) {
      seen.push({ host: u.host, kind: "other", url });
      return json({ error: "down" }, 500);
    }
    if (u.pathname === "/v0/transactions") {
      seen.push({ host: u.host, kind: "enhanced", url });
      return json((body.transactions as string[]).map((s) => all.get(s)).filter((t): t is HistoryTx => !!t).map(toEnhanced));
    }
    const id = body.id ?? 1;
    if (body.method === "getTransactionsForAddress") {
      seen.push({ host: u.host, kind: "gtfa", url });
      return o.gtfaAllowed ? json({ jsonrpc: "2.0", id, result: { data: [], paginationToken: null } }) : json({ jsonrpc: "2.0", id, error: { code: -32403, message: "This method is only available on the Developer plan" } }, 403);
    }
    if (body.method === "getSignaturesForAddress") {
      seen.push({ host: u.host, kind: "signatures", url });
      const [wallet, opts] = body.params as [string, { limit: number; before?: string }];
      const list = byWallet.get(wallet) ?? [];
      const start = opts.before ? list.findIndex((t) => t.signature === opts.before) + 1 : 0;
      return json({ jsonrpc: "2.0", id, result: list.slice(start, start + opts.limit).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.time === null ? null : Math.floor(t.time / 1000), err: t.failed ? { err: 1 } : null })) });
    }
    if (body.method === "getTransaction") {
      seen.push({ host: u.host, kind: "transaction", url });
      const t = all.get(body.params[0]);
      return json({ jsonrpc: "2.0", id, result: t ? toParsed(t) : null });
    }
    seen.push({ host: u.host, kind: "other", url });
    return json({ error: "unknown" }, 404);
  }) as typeof fetch;

  return { fetchImpl, seen, count: (k?: Seen["kind"]) => seen.filter((s) => !k || s.kind === k).length };
}
