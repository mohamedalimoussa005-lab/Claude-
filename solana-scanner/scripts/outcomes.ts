/**
 * Outcome Tracker V1 — observes the scanner, never feeds it.
 *
 *   npm run outcomes:capture [-- --wallets]   normal scan → T0 snapshots for every scored token
 *                                             (Step 3 on selectCandidates as in the UI; Step 4 only with --wallets)
 *   npm run outcomes:update                   fills the checkpoints that are due, from the exact T0 pair
 *   npm run outcomes:report                   descriptive report
 *   npm run outcomes:export                   flat CSV (T0 signals + raw outcomes) next to the dataset
 *   npm run outcomes:status                   collection health (no network)
 *   npm run outcomes:backup                   copy of the dataset under data/outcomes/backups/
 *
 * Every write of the dataset runs under a single-writer lock (src/outcomes/lock.ts).
 *
 * Dataset: data/outcomes/observations.json (git-ignored; OUTCOMES_DIR overrides). Delete the
 * directory to reset. Server-side only: keys stay in this process and are never written.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DexScreenerClient } from "../src/api/dexscreener.ts";
import { extractPairs, normalizePair } from "../src/domain/normalize.ts";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { mostLiquidPairPerToken, scanSolana } from "../src/domain/scanner.ts";
import { assessToken } from "../src/final/assessment.ts";
import { OnchainService, selectCandidates } from "../src/onchain/service.ts";
import type { OnchainResult } from "../src/onchain/service.ts";
import { exportRows, formatReport, toCsv } from "../src/outcomes/report.ts";
import { withLock } from "../src/outcomes/lock.ts";
import { formatStatus } from "../src/outcomes/status.ts";
import { addObservations, backupStore, datasetBytes, defaultOutcomesDir, fileOf, loadStore, replaceOutcomes, saveStore } from "../src/outcomes/store.ts";
import { applyFetch, buildObservation, dueCheckpoints } from "../src/outcomes/tracker.ts";
import type { EngineStatus, FetchResult, Observation } from "../src/outcomes/tracker.ts";
import { createServerSolanaRpc } from "../src/rpc/serverRpc.ts";
import { scorePairs } from "../src/scoring/score.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import type { WalletIntel } from "../src/wallets/intel.ts";
import { createServerWalletIntelService } from "../src/wallets/server/walletIntel.ts";

const [cmd, ...args] = process.argv.slice(2);
const dir = defaultOutcomesDir();

async function capture() {
  const withWallets = args.includes("--wallets");
  const dex = new DexScreenerClient();
  const scan = await scanSolana(dex);
  const rows = scorePairs(mostLiquidPairPerToken(scan.pairs), scan.fetchedAt);
  const candidates = new Set(selectCandidates(rows).map((r) => r.pair.pairAddress));
  const serverRpc = createServerSolanaRpc({ env: process.env });
  const onchain = new OnchainService(serverRpc.rpc);
  const wallets = withWallets ? createServerWalletIntelService({ rpc: serverRpc.rpc, dex, env: process.env, deep: false, config: WALLET_CONFIG }).service : null;
  let commit: string | null = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    commit = null;
  }

  const obs: Observation[] = [];
  for (const row of rows) {
    let oc: OnchainResult | null = null;
    let step3: EngineStatus = "NOT_RUN";
    let intel: WalletIntel | null = null;
    let step4: EngineStatus = "NOT_RUN";
    const candidate = candidates.has(row.pair.pairAddress);
    if (candidate) {
      try {
        oc = await onchain.analyze(row);
        step3 = Object.values(oc.data).some((v) => v && typeof v === "object" && "status" in v && v.status !== "ok") ? "PARTIAL" : "COMPLETE";
      } catch {
        step3 = "FAILED";
      }
      if (wallets && oc) {
        try {
          intel = await wallets.analyze(row, oc);
          step4 = intel.analysisStatus === "complete" ? "COMPLETE" : intel.analysisStatus === "partial" ? "PARTIAL" : "FAILED";
        } catch {
          step4 = "FAILED";
        }
      }
    }
    const assessment = assessToken({ score: row.score, onchain: oc, wallets: intel });
    obs.push(buildObservation({ pair: row.pair, score: row.score, assessment, capturedAt: scan.fetchedAt, candidate, onchain: oc, step3Status: step3, wallets: intel, step4Status: step4, scannerCommit: commit }));
  }
  // Only the read-modify-write of the dataset is locked (the scan itself may take minutes).
  const { added, skipped, total } = await withLock(dir, () => {
    const r = addObservations(loadStore(dir), obs);
    saveStore(r.store, dir);
    return { added: r.added, skipped: r.skipped, total: r.store.observations.length };
  });
  const st = (k: "step3Status" | "step4Status") => ["COMPLETE", "PARTIAL", "FAILED"].map((v) => `${v} ${obs.filter((o) => o.snapshot.funnel[k] === v).length}`).join(" / ");
  console.log(`[CAPTURE] ${new Date().toISOString()} T0 ${new Date(scan.fetchedAt).toISOString()} · tokens ${rows.length} · candidats ${candidates.size} · ajoutées ${added} · déjà présentes ${skipped} · Step 3 ${st("step3Status")} · Step 4 ${withWallets ? st("step4Status") : "non demandé"}`);
  console.log(`[DATASET] ${total} observation(s) · ${datasetBytes(dir) ?? 0} octets`);
}

async function update() {
  // Load → fetch → save under the lock: a concurrent capture cannot be overwritten by a stale copy.
  await withLock(dir, updateLocked);
}

async function updateLocked() {
  const now = Date.now();
  const store = loadStore(dir);
  const due = store.observations.filter((o) => dueCheckpoints(o, now).length);
  // One batched lookup per 30 exact pair addresses (the T0 pair, never another pair of the mint).
  const byChain = new Map<string, string[]>();
  for (const o of due) byChain.set(o.snapshot.identity.chainId, [...new Set([...(byChain.get(o.snapshot.identity.chainId) ?? []), o.snapshot.identity.pairAddress])]);
  const results = new Map<string, FetchResult>();
  const dex = new DexScreenerClient();
  let calls = 0;
  for (const [chain, pairs] of byChain) {
    for (let i = 0; i < pairs.length; i += 30) {
      const batch = pairs.slice(i, i + 30);
      try {
        calls++;
        const got = new Map<string, NormalizedPair>();
        for (const raw of extractPairs(await dex.getPairsByPairAddresses(chain, batch))) {
          const p = normalizePair(raw);
          if (p) got.set(p.pairAddress, p);
        }
        for (const a of batch) results.set(`${chain}:${a}`, got.has(a) ? { status: "OK", pair: got.get(a)! } : { status: "UNAVAILABLE" });
      } catch (e) {
        for (const a of batch) results.set(`${chain}:${a}`, { status: "PROVIDER_ERROR", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  const fetchedAt = Date.now();
  const updated = store.observations.map((o) => applyFetch(o, fetchedAt, results.get(`${o.snapshot.identity.chainId}:${o.snapshot.identity.pairAddress}`) ?? null));
  saveStore(replaceOutcomes(store, updated), dir);
  // Checkpoint records written or changed by this run, by status.
  const written: Record<string, number> = { OK: 0, UNAVAILABLE: 0, PROVIDER_ERROR: 0, MISSED: 0 };
  store.observations.forEach((o, i) => {
    for (const [k, c] of Object.entries(updated[i].outcomes)) if (c && JSON.stringify(c) !== JSON.stringify(o.outcomes[k as keyof typeof o.outcomes])) written[c.status]++;
  });
  console.log(`[UPDATE] ${new Date(fetchedAt).toISOString()} · observations avec checkpoint dû ${due.length} · appels DexScreener ${calls} · OK ${written.OK} · UNAVAILABLE ${written.UNAVAILABLE} · PROVIDER_ERROR ${written.PROVIDER_ERROR} · MISSED ${written.MISSED}`);
  console.log(`[DATASET] ${store.observations.length} observation(s) · ${datasetBytes(dir) ?? 0} octets`);
}

async function main() {
  if (cmd === "capture") return capture();
  if (cmd === "update") return update();
  if (cmd === "report") return console.log(formatReport(loadStore(dir).observations, Date.now()));
  if (cmd === "status") return console.log(formatStatus(loadStore(dir).observations, Date.now(), datasetBytes(dir), fileOf(dir)));
  if (cmd === "backup") {
    const dest = await withLock(dir, () => backupStore(dir));
    return console.log(dest ? `[BACKUP] ${dest}` : "[BACKUP] aucun dataset à sauvegarder");
  }
  if (cmd === "export") {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "export.csv");
    writeFileSync(f, toCsv(exportRows(loadStore(dir).observations)));
    return console.log(`export → ${f}`);
  }
  console.log("usage : outcomes.ts capture [--wallets] | update | report | export | status | backup");
  process.exitCode = 1;
}
await main();
