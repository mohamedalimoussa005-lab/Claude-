/**
 * Public RPC wallet-history provider: wraps the existing read-only SolanaRpc
 * (getSignaturesForAddress + getTransaction, ≈ 1 transaction/s). Pages are
 * small; oldest-first is only possible when the signature walk reaches the
 * start of the history within its budget.
 */

import type { SignatureInfo, SolanaRpc } from "../onchain/rpc.ts";
import { HISTORY_CONFIG } from "./config.ts";
import type { HistoryConfig } from "./config.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { normalizeParsed } from "./normalize.ts";
import type { HistoryPage, HistoryTx, PageRequest, WalletHistoryProvider } from "./types.ts";

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
    return req.order === "asc" ? this.oldest(req) : this.newest(req);
  }

  private async newest(req: PageRequest): Promise<HistoryPage> {
    const cur = decodeCursor(req.cursor);
    const before = cur?.kind === "sig" ? cur.value : undefined;
    const limit = Math.max(1, Math.min(req.limit, this.config.maxPageLimit));
    const calls = { n: 1 };
    const sigs = await this.rpc.getSignatures(req.address, limit, before);
    const { txs, missing } = await this.fetchAll(sigs, req, calls);
    const next = sigs.length === limit ? encodeCursor({ kind: "sig", value: sigs[sigs.length - 1].signature }) : null;
    return { txs, nextCursor: next, provider: "public_rpc", strategy: "public_rpc", calls: calls.n, missing, ...(cur?.kind === "gtfa" ? { restarted: true } : {}) };
  }

  private async oldest(req: PageRequest): Promise<HistoryPage> {
    const calls = { n: 0 };
    if (req.cursor) return { txs: [], nextCursor: null, provider: "public_rpc", strategy: "public_rpc", calls: 0, missing: 0, reachedStart: false, note: "oldest-first paging beyond the first page is not available on the public RPC" };
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
    if (!reached) return { txs: [], nextCursor: null, provider: "public_rpc", strategy: "public_rpc", calls: calls.n, missing: 0, reachedStart: false, note: `start of history beyond ${all.length} signatures` };
    const oldest = all.slice(-Math.max(1, Math.min(req.limit, this.config.maxPageLimit))).reverse();
    const { txs, missing } = await this.fetchAll(oldest, req, calls);
    return { txs, nextCursor: null, provider: "public_rpc", strategy: "public_rpc", calls: calls.n, missing, reachedStart: true };
  }

  private async fetchAll(sigs: SignatureInfo[], req: PageRequest, calls: { n: number }): Promise<{ txs: HistoryTx[]; missing: number }> {
    const txs: HistoryTx[] = [];
    let missing = 0;
    for (const s of sigs) {
      if (s.err) continue;
      const hit = req.cached?.(s.signature);
      if (hit) {
        txs.push(hit);
        continue;
      }
      calls.n++;
      const tx = await this.rpc.getTransaction(s.signature);
      if (!tx) {
        missing++;
        continue;
      }
      txs.push(normalizeParsed(tx, "public-rpc"));
    }
    return { txs, missing };
  }
}
