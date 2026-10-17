/** A fictional on-disk history (cache + saved report) with every anomaly the diagnostic must explain. */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { MemoryHistoryCache } from "../../src/history/cache.ts";
import { WalletHistoryService } from "../../src/history/service.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import { addr, ATA_PROGRAM, buy, buyCreatingAta, DEMO_START, DEX_PROGRAM, sell, sellClosingAta, tx } from "../../src/smart-money/demo/fixtures.ts";
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
export const MINTS = { P: addr(60), Q: addr(61), R: addr(62), S: addr(63), micro: addr(80), t2022: addr(81), cosigned: addr(82), sponsored: addr(83), control: addr(84) };
export const POOL = addr(200);

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
  // Rent cases.
  const micro = tx({ sig: "rent-micro", time: T0 + 100 * H, wallet: W, sol: -(0.0025 + 0.000005), tokens: { [MINTS.micro]: { ui: 100 } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [POOL]: 2_500_000 } });
  micro.tokenDeltas[POOL] = { [MINTS.micro]: { raw: "-100000000", decimals: 6 } };
  out.push(micro);
  out.push(tx({ sig: "rent-2022", time: T0 + 101 * H, wallet: W, sol: -(1 + 0.0021576 + 0.000005), tokens: { [MINTS.t2022]: { ui: 50 } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [addr(201)]: 2_157_600 } }));
  out.push({ ...buyCreatingAta("rent-cosigned", T0 + 102 * H, W, MINTS.cosigned, 10, 0.5, addr(202)), signers: [W, addr(250)] });
  out.push({ ...buyCreatingAta("rent-sponsored", T0 + 103 * H, W, MINTS.sponsored, 10, 0.5, addr(203)), feePayer: addr(252), signers: [addr(252), W] });
  out.push(buyCreatingAta("rent-control", T0 + 104 * H, W, MINTS.control, 10, 0.5, addr(204)), sellClosingAta("rent-control-s", T0 + 105 * H, W, MINTS.control, 10, 1, addr(204)));
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
export async function writeFixture(dir: string, o: { report?: boolean; patch?: (r: WalletReport) => void; extraCacheTxs?: HistoryTx[] } = {}): Promise<Fixture> {
  const txs = fixtureTxs();
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
