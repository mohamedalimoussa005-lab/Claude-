/**
 * Reduces a raw capture (scripts/social/coordination-capture.ts) to a test fixture:
 *   - mint transactions: only those that move the token (swaps, transfers); the others are counted, not stored;
 *   - wallet histories: only the inbound SOL transfers (all that funding tracing reads), coverage kept as captured.
 *
 *   node --experimental-strip-types --no-warnings scripts/social/coordination-reduce.ts <capture.json> <fixture.json[.gz]>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { normalizeTx } from "../../src/social/coordination/normalize.ts";
import type { RawTx } from "../../src/social/coordination/normalize.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: coordination-reduce.ts <capture.json> <fixture.json[.gz]>");
const cap = JSON.parse(readFileSync(input, "utf8")) as { mint: string; wallets: Record<string, { coverage: unknown; activityCapped: boolean; txs: RawTx[] }>; txs: RawTx[] } & Record<string, unknown>;

const keep: RawTx[] = [];
let dropped = 0;
for (const t of cap.txs) {
  const n = normalizeTx(t);
  if (n.tokenDeltas.some((d) => d.mint === cap.mint)) keep.push(t);
  else dropped++;
}
const wallets: Record<string, unknown> = {};
for (const [w, h] of Object.entries(cap.wallets)) {
  const txs = h.txs.filter((t) => normalizeTx(t).solTransfers.some((x) => x.to === w));
  wallets[w] = { coverage: h.coverage, activityCapped: h.activityCapped, txs, droppedTxs: h.txs.length - txs.length };
}
const json = JSON.stringify({ ...cap, txs: keep, droppedMintTxs: dropped, wallets });
writeFileSync(output, output.endsWith(".gz") ? gzipSync(json, { level: 9 }) : json);
console.error(`kept ${keep.length} mint txs (dropped ${dropped}), ${Object.keys(wallets).length} wallets`);
