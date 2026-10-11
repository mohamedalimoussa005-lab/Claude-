/**
 * Loads the reduced captures of Phase 5C (read-only public-RPC reads made on 2026-10-09 by
 * scripts/social/coordination-capture.ts, then reduced by coordination-reduce.ts). NO network call.
 * What is in a capture: the oldest transactions of the token that move it, and for each launch-cohort wallet (and
 * its funder, up to 2 hops) the inbound SOL transfers of its oldest transactions. Coverage is stored with the data.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { normalizeTx } from "../../../../src/social/coordination/normalize.ts";
import type { RawTx } from "../../../../src/social/coordination/normalize.ts";
import type { Coverage } from "../../../../src/social/coordination/model.ts";
import type { FundingProvider } from "../../../../src/social/coordination/funding.ts";
import type { CoordinationInput } from "../../../../src/social/coordination/analyze.ts";

export interface Capture {
  mint: string;
  capturedAt: string;
  creator: string | null;
  supplyRaw: string | null;
  coverage: Coverage;
  txs: RawTx[];
  droppedMintTxs: number;
  wallets: Record<string, { coverage: Coverage; activityCapped: boolean; txs: RawTx[] }>;
}

export const TOKENS = ["A", "B", "C", "F"] as const;
export type TokenKey = (typeof TOKENS)[number];

const cache = new Map<string, Capture>();
export function loadCapture(key: TokenKey): Capture {
  let c = cache.get(key);
  if (!c) cache.set(key, (c = JSON.parse(gunzipSync(readFileSync(new URL(`./${key}.json.gz`, import.meta.url))).toString("utf8")) as Capture));
  return c;
}

export function providerOf(c: Capture): FundingProvider {
  return (wallet) => {
    const h = c.wallets[wallet];
    if (!h) return null;
    const inbound = h.txs.flatMap((t) => normalizeTx(t).solTransfers.filter((x) => x.to === wallet));
    return { wallet, inbound, coverage: h.coverage, activityCapped: h.activityCapped };
  };
}

export function inputOf(c: Capture, over: Partial<CoordinationInput> = {}): CoordinationInput {
  return { mint: c.mint, creator: c.creator, supplyRaw: c.supplyRaw ? BigInt(c.supplyRaw) : null, txs: c.txs.map(normalizeTx), coverage: c.coverage, provider: providerOf(c), ...over };
}
