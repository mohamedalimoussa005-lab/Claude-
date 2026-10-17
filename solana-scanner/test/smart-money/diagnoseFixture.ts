/** A fictional on-disk history (cache + saved report) with every anomaly the diagnostic must explain. */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { MemoryHistoryCache } from "../../src/history/cache.ts";
import { WalletHistoryService } from "../../src/history/service.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import { addr, ATA_PROGRAM, buy, DEMO_START, DEX_PROGRAM, sell, swapTx, tx } from "../../src/smart-money/demo/fixtures.ts";
import { FixtureHistoryProvider } from "../../src/smart-money/ingest/fixtureProvider.ts";
import { ingestWallet } from "../../src/smart-money/ingest/ingest.ts";
import { buildReport } from "../../src/smart-money/ingest/report.ts";
import type { WalletReport } from "../../src/smart-money/ingest/report.ts";
import { analyzeWallet } from "../../src/smart-money/pnl/profile.ts";
import { atomicWriteJson } from "../../src/smart-money/store/atomic.ts";
import { SmartMoneyStore } from "../../src/smart-money/store/store.ts";

export const W = addr(11);
export const T0 = DEMO_START;
export const H = 3_600_000;
export const MINTS = { P: addr(60), Q: addr(61), R: addr(62), S: addr(63), micro: addr(80), t2022: addr(81), cosigned: addr(82), sponsored: addr(83), control: addr(84), incomplete: addr(85), foreign: addr(86) };

export function fixtureTxs(): HistoryTx[] {
  const out: HistoryTx[] = [];
  // Sales of tokens bought before the window (P sold in three pieces, Q once).
  out.push(sell("p1", T0 + 1 * H, W, MINTS.P, 100, 1), sell("p2", T0 + 2 * H, W, MINTS.P, 100, 1), sell("p3", T0 + 30 * H, W, MINTS.P, 50, 1), sell("q1", T0 + 5 * H, W, MINTS.Q, 70, 1));
  // R: a buy and a sell in the SAME slot; the ledger puts the sell first (signature order) → looks orphan.
  out.push(tx({ sig: "a-sell-R", time: T0 + 10 * H, slot: 90000, wallet: W, sol: 2, tokens: { [MINTS.R]: { ui: -10 } } }), tx({ sig: "z-buy-R", time: T0 + 10 * H, slot: 90000, wallet: W, sol: -1, tokens: { [MINTS.R]: { ui: 10 } } }));
  // S: same slot but the buy sorts first → harmless.
  out.push(tx({ sig: "a-buy-S", time: T0 + 12 * H, slot: 90100, wallet: W, sol: -1, tokens: { [MINTS.S]: { ui: 10 } } }), tx({ sig: "z-sell-S", time: T0 + 12 * H, slot: 90100, wallet: W, sol: 2, tokens: { [MINTS.S]: { ui: -10 } } }));
  // Clean round trips inside the window (holding times 2…10 h).
  [2, 3, 4, 6, 8, 10].forEach((hold, i) => out.push(buy(`rt-b${i}`, T0 + (20 + i * 12) * H, W, addr(70 + i), 1000, 1), sell(`rt-s${i}`, T0 + (20 + i * 12 + hold) * H, W, addr(70 + i), 1000, 2)));
  // Rent cases (engine v2). Each swap has a real counterparty (the pool) and a protocol fee account.
  const sw = (sig: string, h: number, mint: string, o: Partial<Parameters<typeof swapTx>[0]> = {}) => swapTx({ sig, time: T0 + h * H, wallet: W, mint, side: "buy", ui: 100, tradeSol: 0.5, ...o });
  // A 0.0025 SOL buy on a token account that already exists: the old numeric rule mistook the pool's SOL for a rent.
  out.push(sw("rent-micro", 100, MINTS.micro, { tradeSol: 0.0025, programs: [DEX_PROGRAM, ATA_PROGRAM] }));
  // A Token-2022-sized account the wallet creates itself: proven by its derived address.
  out.push(sw("rent-2022", 101, MINTS.t2022, { tradeSol: 1, createAta: true, token2022: true, rentLamports: 2_157_600 }));
  // A co-signer that nets nothing (temporary key): the wallet is the one who paid.
  out.push(sw("rent-cosigned", 102, MINTS.cosigned, { createAta: true, signers: [W, addr(250)] }));
  // Another signer pays the rent: who funded it is not provable.
  out.push(sw("rent-sponsored", 103, MINTS.sponsored, { createAta: true, signers: [W, addr(252)], rentPayer: addr(252) }));
  // Enhanced decoding: signers incomplete.
  out.push({ ...sw("rent-incomplete", 104, MINTS.incomplete, { createAta: true }), signersComplete: false });
  // A standard-size account that is NOT the wallet's token account.
  out.push(sw("rent-foreign", 105, MINTS.foreign, { createAta: true, ataAccount: addr(204) }));
  // Control: the wallet creates and then closes its own token account.
  out.push(sw("rent-control", 106, MINTS.control, { createAta: true }), sw("rent-control-s", 107, MINTS.control, { side: "sell", closeAta: true }));
  return out;
}

export const walletKey = (w: string) => createHash("sha256").update(w).digest("hex").slice(0, 12);

export interface Fixture {
  dir: string;
  txs: HistoryTx[];
  report: WalletReport;
  cachePath: string;
}

/** Writes cache/history.json and snapshots/wallet-*.json under `dir`, as a real `wallet --live --save` would. */
export async function writeFixture(dir: string, o: { report?: boolean; patch?: (r: WalletReport) => void; extraCacheTxs?: HistoryTx[]; txs?: HistoryTx[] } = {}): Promise<Fixture> {
  const txs = o.txs ?? fixtureTxs();
  const cache = new MemoryHistoryCache();
  const service = new WalletHistoryService({ providers: [new FixtureHistoryProvider(txs)], cache });
  const ingest = await ingestWallet(service, W, { maxPages: 50, maxTransactions: 1000, pageLimit: 100, historyEndTrusted: false });
  for (const t of o.extraCacheTxs ?? []) cache.putTx(W, t);
  const a = analyzeWallet(W, ingest.txs, { coverage: { complete: ingest.complete, oldestTime: ingest.oldestTime } });
  const report = buildReport({ ingest, ledger: a.ledger, pnl: a.pnl, profile: a.profile, source: "live", budget: null, transport: "authenticated_rpc: 50 ok / 0 échecs" });
  // Make the collection look like a RPC run that skipped 5 failed signatures.
  report.history.listed = txs.length + 5;
  report.history.failedSkipped = 5;
  report.history.missing = 0;
  report.history.stopReason = "max_pages";
  report.history.complete = false;
  report.budget = { limits: { maxCalls: 500, maxCredits: 500 }, calls: report.history.pages + report.history.downloaded, credits: report.history.pages + report.history.downloaded, byKind: {}, refusedByBudget: 0, refusedByPolicy: 0, exhaustedBy: null };
  o.patch?.(report);
  const cachePath = join(dir, "cache", "history.json");
  atomicWriteJson(cachePath, cache.snapshot());
  if (o.report !== false) await new SmartMoneyStore(dir, () => T0 + 200 * H).writeSnapshot(`wallet-${walletKey(W)}`, report);
  return { dir, txs, report, cachePath };
}
