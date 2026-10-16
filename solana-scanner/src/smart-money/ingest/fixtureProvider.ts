/**
 * A WalletHistoryProvider backed by an in-memory list of HistoryTx: it lets
 * the real service, cache and pagination run with no network (tests, demo,
 * saved histories). It can simulate the awkward cases: transactions that are
 * listed but unretrievable, a source that fails, a cursor that never moves.
 * Labelled "public_rpc" only because the provider name type is closed.
 */

import type { HistoryPage, HistoryTx, PageRequest, WalletHistoryProvider } from "../../history/types.ts";
import { ProviderUnavailableError } from "../../history/provider.ts";
import { decodeCursor, encodeCursor } from "../../history/cursor.ts";

export interface FixtureOptions {
  /** Signatures listed but not retrievable (counted as `missing`). */
  unretrievable?: ReadonlySet<string>;
  /** Fail (provider unavailable) from the n-th call on. */
  failFromCall?: number;
  /** Always answer with the same cursor. */
  stall?: boolean;
  /** Smaller than the requested limit when set. */
  maxPageSize?: number;
}

export class FixtureHistoryProvider implements WalletHistoryProvider {
  readonly name = "public_rpc" as const;
  readonly requests: PageRequest[] = [];
  /** Transactions "downloaded" (not served from the cache) over the provider's life. */
  downloaded = 0;
  private readonly txs: HistoryTx[];
  private readonly o: FixtureOptions;
  private calls = 0;

  constructor(txs: HistoryTx[], o: FixtureOptions = {}) {
    this.txs = [...txs].filter((t) => !t.failed).sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0) || (b.time ?? 0) - (a.time ?? 0) || (a.signature < b.signature ? 1 : -1));
    this.o = o;
  }

  async getPage(req: PageRequest): Promise<HistoryPage> {
    this.calls++;
    this.requests.push(req);
    if (this.o.failFromCall !== undefined && this.calls >= this.o.failFromCall) {
      throw new ProviderUnavailableError("public_rpc", "network", "fixture source failed", [{ source: "public_rpc", result: "network" }]);
    }
    const cur = decodeCursor(req.cursor);
    const start = cur ? this.txs.findIndex((t) => t.signature === cur.value) + 1 : 0;
    const size = Math.min(req.limit, this.o.maxPageSize ?? req.limit);
    const slice = this.txs.slice(start, start + size);
    const out: HistoryTx[] = [];
    let missing = 0;
    let fetched = 0;
    let fromCache = 0;
    for (const t of slice) {
      if (this.o.unretrievable?.has(t.signature)) {
        missing++;
        continue;
      }
      const hit = req.cached?.(t.signature);
      if (hit) fromCache++;
      else {
        fetched++;
        this.downloaded++;
      }
      out.push(hit ?? t);
    }
    const more = start + size < this.txs.length;
    const next = this.o.stall ? (req.cursor ?? encodeCursor({ kind: "sig", value: slice[slice.length - 1]?.signature ?? "none" })) : more ? encodeCursor({ kind: "sig", value: slice[slice.length - 1].signature }) : null;
    return {
      txs: out,
      nextCursor: next,
      provider: "public_rpc",
      strategy: "public_rpc",
      calls: 1 + fetched,
      missing,
      note: "fixture",
      stats: { signaturesRequested: size, signaturesListed: slice.length, transactionsFetched: fetched, transactionsFromCache: fromCache, transactionsSucceeded: slice.length, transactionsFailed: 0, transactionsNormalized: out.length, missing },
      trace: [{ source: "public_rpc", result: "success" }],
    };
  }
}
