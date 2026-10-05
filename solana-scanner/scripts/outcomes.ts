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
 *   npm run outcomes:archive-legacy           move a v1 (pre-timeline) dataset to backups/…legacy-v0… (never migrated)
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
import { addObservations, archiveLegacyStore, backupStore, datasetBytes, defaultOutcomesDir, fileOf, loadStore, replaceOutcomes, saveStore } from "../src/outcomes/store.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { applyFetch, buildObservation, decisionMarketFrom, dueCheckpoints } from "../src/outcomes/tracker.ts";
import type { EngineStatus, FetchResult, Observation, Timeline } from "../src/outcomes/tracker.ts";
import { createServerSolanaRpc } from "../src/rpc/serverRpc.ts";
import { scorePairs } from "../src/scoring/score.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import type { WalletIntel } from "../src/wallets/intel.ts";
import { createServerWalletIntelService } from "../src/wallets/server/walletIntel.ts";

const [cmd, ...args] = process.argv.slice(2);
const dir = defaultOutcomesDir();

/** One lookup per 30 exact pair addresses; a missing pair is UNAVAILABLE, a failed request PROVIDER_ERROR. */
async function fetchPairs(dex: DexScreenerClient, chain: string, pairs: string[]): Promise<{ results: Map<string, FetchResult>; calls: number; at: number }> {
  const results = new Map<string, FetchResult>();
  let calls = 0;
  for (let i = 0; i < pairs.length; i += 30) {
    const batch = pairs.slice(i, i + 30);
    try {
      calls++;
      const got = new Map<string, NormalizedPair>();
      for (const raw of extractPairs(await dex.getPairsByPairAddresses(chain, batch))) {
        const p = normalizePair(raw);
        if (p) got.set(p.pairAddress, p);
      }
      for (const a of batch) results.set(a, got.has(a) ? { status: "OK", pair: got.get(a)! } : { status: "UNAVAILABLE" });
    } catch (e) {
      for (const a of batch) results.set(a, { status: "PROVIDER_ERROR", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, calls, at: Date.now() };
}

async function capture() {
  const captureStartedAt = Date.now();
  const withWallets = args.includes("--wallets");
  const maxArg = args.indexOf("--candidates");
  const maxCandidates = maxArg >= 0 ? Number(args[maxArg + 1]) : ONCHAIN_CONFIG.candidates.max;
  loadStore(dir); // fail fast on a legacy / unreadable dataset, before the expensive part
  const dex = new DexScreenerClient();
  const scan = await scanSolana(dex);
  const marketObservedAt = scan.fetchedAt;
  const rows = scorePairs(mostLiquidPairPerToken(scan.pairs), scan.fetchedAt);
  const step2CompletedAt = Date.now();
  const candidateRows = selectCandidates(rows, { ...ONCHAIN_CONFIG, candidates: { ...ONCHAIN_CONFIG.candidates, max: maxCandidates } });
  const candidates = new Set(candidateRows.map((r) => r.pair.pairAddress));
  let commit: string | null = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    commit = null;
  }
  let dexCalls = 0;
  let added = 0;
  let skipped = 0;
  const all: Observation[] = [];
  const save = (obs: Observation[]) =>
    withLock(dir, () => {
      const r = addObservations(loadStore(dir), obs);
      saveStore(r.store, dir);
      added += r.added;
      skipped += r.skipped;
      all.push(...obs);
    });

  // 1. Step-2-only tokens: decision available right after scoring; one batched exact-pair lookup for its market.
  const plain = rows.filter((r) => !candidates.has(r.pair.pairAddress));
  const assessed = plain.map((row) => ({ row, assessment: assessToken({ score: row.score }), at: Date.now() }));
  const byChain = new Map<string, string[]>();
  for (const { row } of assessed) byChain.set(row.pair.chainId, [...(byChain.get(row.pair.chainId) ?? []), row.pair.pairAddress]);
  const market = new Map<string, { fetch: FetchResult; at: number }>();
  for (const [chain, pairs] of byChain) {
    const f = await fetchPairs(dex, chain, pairs);
    dexCalls += f.calls;
    for (const a of pairs) market.set(a, { fetch: f.results.get(a)!, at: f.at });
  }
  const plainObs = assessed.map(({ row, assessment, at }) => {
    const m = market.get(row.pair.pairAddress)!;
    const timeline: Timeline = { captureStartedAt, marketObservedAt, step2CompletedAt, step3StartedAt: null, step3CompletedAt: null, step4StartedAt: null, step4CompletedAt: null, assessmentCompletedAt: at, decisionAvailableAt: at, snapshotFinalizedAt: Date.now() };
    return buildObservation({ pair: row.pair, score: row.score, assessment, timeline, decisionMarket: decisionMarketFrom(row.pair.pairAddress, m.fetch, m.at), candidate: false, onchain: null, step3Status: "NOT_RUN", wallets: null, step4Status: "NOT_RUN", scannerCommit: commit });
  });
  await save(plainObs);

  // 2. Candidates, one at a time: Step 3 (+ Step 4), FinalAssessment, then the market of that exact pair; saved at once.
  const serverRpc = createServerSolanaRpc({ env: process.env });
  const onchain = new OnchainService(serverRpc.rpc);
  const wallets = withWallets ? createServerWalletIntelService({ rpc: serverRpc.rpc, dex, env: process.env, deep: false, config: WALLET_CONFIG }).service : null;
  const perCandidate: string[] = [];
  for (const row of candidateRows) {
    let oc: OnchainResult | null = null;
    let step3: EngineStatus = "FAILED";
    let intel: WalletIntel | null = null;
    let step4: EngineStatus = "NOT_RUN";
    const step3StartedAt = Date.now();
    try {
      oc = await onchain.analyze(row);
      step3 = Object.values(oc.data).some((v) => v && typeof v === "object" && "status" in v && v.status !== "ok") ? "PARTIAL" : "COMPLETE";
    } catch {
      step3 = "FAILED";
    }
    const step3CompletedAt = Date.now();
    let step4StartedAt: number | null = null;
    let step4CompletedAt: number | null = null;
    if (wallets && oc) {
      step4StartedAt = Date.now();
      try {
        intel = await wallets.analyze(row, oc);
        step4 = intel.analysisStatus === "complete" ? "COMPLETE" : intel.analysisStatus === "partial" ? "PARTIAL" : "FAILED";
      } catch {
        step4 = "FAILED";
      }
      step4CompletedAt = Date.now();
    }
    const assessment = assessToken({ score: row.score, onchain: oc, wallets: intel });
    const decisionAvailableAt = Date.now();
    const f = await fetchPairs(dex, row.pair.chainId, [row.pair.pairAddress]);
    dexCalls += f.calls;
    const timeline: Timeline = { captureStartedAt, marketObservedAt, step2CompletedAt, step3StartedAt, step3CompletedAt, step4StartedAt, step4CompletedAt, assessmentCompletedAt: decisionAvailableAt, decisionAvailableAt, snapshotFinalizedAt: Date.now() };
    const o = buildObservation({ pair: row.pair, score: row.score, assessment, timeline, decisionMarket: decisionMarketFrom(row.pair.pairAddress, f.results.get(row.pair.pairAddress)!, f.at), candidate: true, onchain: oc, step3Status: step3, wallets: intel, step4Status: step4, scannerCommit: commit });
    await save([o]);
    perCandidate.push(`${row.pair.tokenSymbol ?? row.pair.tokenAddress} step3 ${((step3CompletedAt - step3StartedAt) / 1000).toFixed(1)} s${step4CompletedAt !== null ? ` · step4 ${((step4CompletedAt - step4StartedAt!) / 1000).toFixed(1)} s` : ""} · latence décision ${((decisionAvailableAt - marketObservedAt) / 1000).toFixed(1)} s · marché ${o.snapshot.decisionMarket.status}`);
  }

  const captureCompletedAt = Date.now();
  const st = (k: "step3Status" | "step4Status") => ["COMPLETE", "PARTIAL", "FAILED"].map((v) => `${v} ${all.filter((o) => o.snapshot.funnel[k] === v).length}`).join(" / ");
  console.log(
    `[CAPTURE] started ${new Date(captureStartedAt).toISOString()} · completed ${new Date(captureCompletedAt).toISOString()} · durée ${((captureCompletedAt - captureStartedAt) / 1000).toFixed(1)} s · T0 marché ${new Date(marketObservedAt).toISOString()} · tokens ${rows.length} · candidats ${candidates.size} · ajoutées ${added} · déjà présentes ${skipped} · Step 3 ${st("step3Status")} · Step 4 ${withWallets ? st("step4Status") : "non demandé"} · appels DexScreener (marché à la décision) ${dexCalls}`,
  );
  for (const l of perCandidate) console.log(`[CAPTURE]   ${l}`);
  console.log(`[DATASET] ${loadStore(dir).observations.length} observation(s) · ${datasetBytes(dir) ?? 0} octets`);
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
    const f = await fetchPairs(dex, chain, pairs);
    calls += f.calls;
    for (const [a, r] of f.results) results.set(`${chain}:${a}`, r);
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
  if (cmd === "archive-legacy") {
    const dest = await withLock(dir, () => archiveLegacyStore(dir));
    return console.log(dest ? `[LEGACY] dataset v1 archivé (inchangé) → ${dest} ; le prochain capture démarre un dataset v2` : "[LEGACY] aucun dataset legacy à archiver");
  }
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
  console.log("usage : outcomes.ts capture [--wallets] [--candidates N] | update | report | export | status | backup | archive-legacy");
  process.exitCode = 1;
}
await main();
