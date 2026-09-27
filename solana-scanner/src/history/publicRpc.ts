/**
 * Public RPC wallet-history provider: wraps the existing read-only SolanaRpc
 * (getSignaturesForAddress + getTransaction, ≈ 1 transaction/s). Pages are
 * small; oldest-first is only possible when the signature walk reaches the
 * start of the history within its budget. Failed transactions are counted,
 * never returned.
 */

import type { SignatureInfo, SolanaRpc } from "../onchain/rpc.ts";
import { HISTORY_CONFIG } from "./config.ts";
import type { HistoryConfig } from "./config.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { normalizeParsed } from "./normalize.ts";
import { classifyFailure } from "./failure.ts";
import { ProviderUnavailableError, traceResult } from "./provider.ts";
import type { HistoryPage, HistoryTx, OriginStatus, PageRequest, PageStats, WalletHistoryProvider } from "./types.ts";

export type HistoryRpc = Pick<SolanaRpc, "getSignatures" | "getTransaction">;

export class PublicRpcHistoryProvider implements WalletHistoryProvider {
  readonly name = "public_rpc" as const;
  private readonly rpc: HistoryRpc;
  private readonly config: HistoryConfig["publicRpc"];

  constructor(rpc: HistoryRpc, config: HistoryConfig["publicRpc"] = HISTORY_CONFIG.publicRpc) {
    this.rpc = rpc;
    this.config = config;
  }

  async getPage(req: PageRequest): Promise<HistoryPage> {
    try {
      const page = req.order === "asc" ? await this.oldest(req) : await this.newest(req);
      return { ...page, trace: [{ source: "public_rpc", result: "success" }] };
    } catch (e) {
      // An exhausted quota (e.g. RPC 413 "data allowance") is its own code; the raw message is not kept in the trace.
      const kind = classifyFailure(e) === "quota_exhausted" ? "quota_exhausted" : (e as { kind?: string }).kind;
      throw new ProviderUnavailableError("public_rpc", kind ?? "unknown", e instanceof Error ? e.message : String(e), [{ source: "public_rpc", result: traceResult(kind) }]);
    }
  }

  private async newest(req: PageRequest): Promise<Omit<HistoryPage, "trace">> {
    const cur = decodeCursor(req.cursor);
    const before = cur?.kind === "sig" ? cur.value : undefined;
    const limit = Math.max(1, Math.min(req.limit, this.config.maxPageLimit));
    const calls = { n: 1 };
    const sigs = await this.rpc.getSignatures(req.address, limit, before);
    const d = await this.fetchAll(sigs, req, calls);
    const next = sigs.length === limit ? encodeCursor({ kind: "sig", value: sigs[sigs.length - 1].signature }) : null;
    return { txs: d.txs, nextCursor: next, provider: "public_rpc", strategy: "public_rpc", calls: calls.n, missing: d.stats.missing, stats: { ...d.stats, signaturesRequested: limit }, ...(cur?.kind === "gtfa" ? { restarted: true } : {}) };
  }

  private async oldest(req: PageRequest): Promise<Omit<HistoryPage, "trace">> {
    const calls = { n: 0 };
    const limit = Math.max(1, Math.min(req.limit, this.config.maxPageLimit));
    const empty = (listed: number, originStatus: OriginStatus, note: string): Omit<HistoryPage, "trace"> => ({
      txs: [],
      nextCursor: null,
      provider: "public_rpc",
      strategy: "public_rpc",
      calls: calls.n,
      missing: 0,
      reachedStart: false,
      originStatus,
      walkedSignatures: listed,
      note,
      stats: { signaturesRequested: limit, signaturesListed: listed, transactionsFetched: 0, transactionsFromCache: 0, transactionsSucceeded: null, transactionsFailed: null, transactionsNormalized: 0, missing: 0 },
    });
    if (req.cursor) return empty(0, "unsupported", "oldest-first paging beyond the first page is not available on the public RPC");
    const all: SignatureInfo[] = [];
    let before: string | undefined;
    let reached = false;
    for (let p = 0; p < this.config.oldestSignaturePages; p++) {
      calls.n++;
      const page = await this.rpc.getSignatures(req.address, 1000, before);
      all.push(...page);
      if (page.length < 1000) {
        reached = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    if (!reached) return empty(all.length, "budget_exhausted", `start of history beyond ${all.length} signatures`);
    const d = await this.fetchAll(all.slice(-limit).reverse(), req, calls);
    return { txs: d.txs, nextCursor: null, provider: "public_rpc", strategy: "public_rpc", calls: calls.n, missing: d.stats.missing, reachedStart: true, originStatus: "reached", walkedSignatures: all.length, stats: { ...d.stats, signaturesRequested: limit } };
  }

  private async fetchAll(sigs: SignatureInfo[], req: PageRequest, calls: { n: number }): Promise<{ txs: HistoryTx[]; stats: PageStats }> {
    const txs: HistoryTx[] = [];
    let missing = 0;
    let failed = 0;
    let fetched = 0;
    let fromCache = 0;
    for (const s of sigs) {
      if (s.err) {
        failed++;
        continue;
      }
      const hit = req.cached?.(s.signature);
      if (hit) {
        txs.push(hit);
        fromCache++;
        continue;
      }
      calls.n++;
      const tx = await this.rpc.getTransaction(s.signature);
      if (!tx) {
        missing++;
        continue;
      }
      fetched++;
      const n = normalizeParsed(tx, "public-rpc");
      if (n.failed) {
        failed++;
        continue;
      }
      txs.push(n);
    }
    return {
      txs,
      stats: {
        signaturesRequested: sigs.length,
        signaturesListed: sigs.length,
        transactionsFetched: fetched,
        transactionsFromCache: fromCache,
        transactionsSucceeded: sigs.length - failed,
        transactionsFailed: failed,
        transactionsNormalized: txs.length,
        missing,
      },
    };
  }
}
