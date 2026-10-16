/**
 * `wallet`, `estimate`, `preflight`: analyse real (or saved / fictional)
 * wallet histories. Safe by default: with no mode flag nothing is fetched.
 *
 *   wallet ADDR --demo                       fictional history through the real service (no network)
 *   wallet ADDR --offline FILE [--file-complete]   saved HistoryTx JSON; "complete" only if you say so
 *   wallet ADDR... --dry-run [--live ...]    estimate calls and credits, send nothing
 *   wallet ADDR... --live --max-credits N --max-calls N --ack-no-autoscale   real run, behind the guard
 * Options: --max-pages N (3) --max-tx N (300) --page-limit N (100) --provider auto|helius|helius-rpc|public --save --emit --json
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHistoryCache } from "../../history/cache.ts";
import { readHeliusKey } from "../../history/server/heliusEnv.ts";
import { WalletHistoryService } from "../../history/service.ts";
import type { HistoryTx } from "../../history/types.ts";
import type { SmartMoneyConfig } from "../config.ts";
import { addr, demoWalletTxs } from "../demo/fixtures.ts";
import { CallBudget } from "../ingest/budget.ts";
import { COSTS_DOCUMENTED_ON, FREE_PLAN } from "../ingest/costModel.ts";
import { estimateIngest, formatEstimate } from "../ingest/estimate.ts";
import { FixtureHistoryProvider } from "../ingest/fixtureProvider.ts";
import { checkLive, LIVE_MAX_CALLS, LIVE_MAX_CREDITS, LIVE_MAX_PAGE_LIMIT, LIVE_MAX_TX_PER_WALLET, LIVE_MAX_WALLETS, SOLANA_ADDRESS } from "../ingest/guard.ts";
import type { ProviderChoice } from "../ingest/guard.ts";
import { ingestWallet } from "../ingest/ingest.ts";
import type { IngestOptions } from "../ingest/ingest.ts";
import { cacheFromSnapshot } from "../ingest/cacheFile.ts";
import type { LiveServiceFactory } from "../ingest/liveTypes.ts";
import { buildReport, formatReport } from "../ingest/report.ts";
import type { ReportSource } from "../ingest/report.ts";
import { profileEvent } from "../pnl/events.ts";
import { analyzeWallet } from "../pnl/profile.ts";
import { atomicWriteJson } from "../store/atomic.ts";
import { SmartMoneyStore } from "../store/store.ts";
import { createHash } from "node:crypto";

export interface WalletDeps {
  /** The only way to reach the network: injected by scripts/smart-money.ts (kept out of src/ on purpose). Absent = no live mode. */
  createLiveService?: LiveServiceFactory;
  /** Tests inject a fake network; never set in production. */
  fetchImpl?: typeof fetch;
  /** Tests only (see createLiveService). */
  testRates?: { heliusPerSecond: number; rpcPerWindow: number };
  now?: () => number;
}

interface Ctx {
  config: SmartMoneyConfig;
  store: SmartMoneyStore;
  env: Record<string, string | undefined>;
  log: (s: string) => void;
  deps: WalletDeps;
}

const VALUE_FLAGS = new Set(["--max-pages", "--max-tx", "--page-limit", "--provider", "--max-credits", "--max-calls", "--offline", "--wallets"]);
const flag = (a: string[], n: string) => a.includes(n);
const opt = (a: string[], n: string) => {
  const i = a.indexOf(n);
  return i >= 0 ? a[i + 1] : undefined;
};
const num = (a: string[], n: string, d: number): number => {
  const v = opt(a, n);
  if (v === undefined) return d;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : NaN;
};
const positionals = (a: string[]) => a.filter((x, i) => !x.startsWith("--") && !VALUE_FLAGS.has(a[i - 1] ?? ""));
const walletKey = (w: string) => createHash("sha256").update(w).digest("hex").slice(0, 12);

/** Worst-case cost of a page of n transactions for the chosen provider (used to shrink a page the budget cannot finish). */
function pageCostFor(provider: ProviderChoice, heliusKey: boolean): NonNullable<IngestOptions["pageCost"]> {
  if (provider === "public" || !heliusKey) return (n) => ({ calls: 1 + n, credits: 0 });
  if (provider === "helius-rpc") return (n) => ({ calls: 1 + n, credits: 1 + n });
  return (n) => ({ calls: 1 + Math.ceil(n / 100), credits: 1 + 100 * Math.ceil(n / 100) });
}

function limits(a: string[]) {
  return { maxPages: num(a, "--max-pages", 3), maxTransactions: num(a, "--max-tx", 300), pageLimit: num(a, "--page-limit", 100) };
}

export async function estimateCommand(args: string[], ctx: Ctx): Promise<number> {
  const l = limits(args);
  const wallets = num(args, "--wallets", 3);
  if ([l.maxPages, l.maxTransactions, l.pageLimit, wallets].some(Number.isNaN)) {
    ctx.log("valeurs numériques invalides");
    return 2;
  }
  ctx.log(formatEstimate(estimateIngest({ wallets, ...l })));
  return 0;
}

export async function preflightCommand(args: string[], ctx: Ctx): Promise<number> {
  const l = limits(args);
  const key = readHeliusKey(ctx.env) !== null;
  const e = estimateIngest({ wallets: LIVE_MAX_WALLETS, ...l });
  ctx.log("Pré-vérification (hors-ligne : aucune requête n'est envoyée)");
  ctx.log(`  Clé Helius dans l'environnement : ${key ? "présente (jamais affichée)" : "ABSENTE → RPC public uniquement"}`);
  ctx.log(`  Autorisation live (SMART_MONEY_LIVE_OK=yes) : ${ctx.env.SMART_MONEY_LIVE_OK === "yes" ? "donnée" : "non donnée"}`);
  ctx.log(`  Limites documentées Helius (plan Free, relevées le ${COSTS_DOCUMENTED_ON}) : ${FREE_PLAN.monthlyCredits.toLocaleString("fr-FR")} crédits/mois · RPC ${FREE_PLAN.rpcRequestsPerSecond} req/s · API enrichies ${FREE_PLAN.enhancedRequestsPerSecond} req/s · getTransactionsForAddress réservé au plan Developer+`);
  ctx.log(`  Plafonds codés pour un essai live : ${LIVE_MAX_WALLETS} wallets · ${LIVE_MAX_CREDITS} crédits · ${LIVE_MAX_CALLS} appels · pages ≤ ${LIVE_MAX_PAGE_LIMIT} · ${LIVE_MAX_TX_PER_WALLET} tx/wallet`);
  ctx.log("  Ce que je ne peux PAS vérifier hors-ligne : votre plan réel, vos crédits restants, l'autoscaling (à confirmer dans le tableau de bord Helius).");
  ctx.log("  Vérifié automatiquement au premier appel live, avec arrêt immédiat : clé refusée (401), droit refusé (403), limite de débit (429), quota épuisé.");
  ctx.log(formatEstimate(e));
  return 0;
}

export async function walletCommand(args: string[], ctx: Ctx): Promise<number> {
  const { log } = ctx;
  const wallets = positionals(args);
  const l = limits(args);
  if ([l.maxPages, l.maxTransactions, l.pageLimit].some(Number.isNaN)) {
    log("--max-pages, --max-tx et --page-limit doivent être des nombres positifs");
    return 2;
  }
  const demo = flag(args, "--demo");
  const offlineFile = opt(args, "--offline");
  const live = flag(args, "--live");
  const dry = flag(args, "--dry-run");
  const provider = (opt(args, "--provider") ?? "auto") as ProviderChoice;
  if (!["auto", "helius", "helius-rpc", "public"].includes(provider)) {
    log("--provider doit valoir auto, helius, helius-rpc ou public");
    return 2;
  }
  if (demo && wallets.length === 0) wallets.push(addr(11));
  for (const w of wallets) if (!SOLANA_ADDRESS.test(w)) {
    log("adresse de wallet invalide");
    return 2;
  }
  if (wallets.length === 0) {
    log("usage : wallet ADDR [ADDR…] (--demo | --offline FILE | --dry-run | --live …)  — voir src/smart-money/cli/wallet.ts");
    return 2;
  }

  const maxCredits = opt(args, "--max-credits") === undefined ? null : Number(opt(args, "--max-credits"));
  const maxCalls = opt(args, "--max-calls") === undefined ? null : Number(opt(args, "--max-calls"));
  const heliusKeyPresent = readHeliusKey(ctx.env) !== null;
  const liveCheck = checkLive({ wallets, provider, maxCredits, maxCalls, ...l, ackNoAutoscale: flag(args, "--ack-no-autoscale"), heliusKeyPresent }, ctx.env);

  if (dry) {
    log(formatEstimate(estimateIngest({ wallets: wallets.length, ...l })));
    if (live) {
      log(liveCheck.ok ? "Garde live : toutes les conditions sont remplies (rien n'a été envoyé : --dry-run)." : `Garde live : REFUSÉE\n${liveCheck.errors.map((e) => `  - ${e}`).join("\n")}`);
      for (const w of liveCheck.warnings) log(`  ! ${w}`);
    }
    return 0;
  }

  let source: ReportSource;
  let makeService: (wallet: string) => { service: WalletHistoryService; budget: CallBudget | null; trusted: boolean; after?: () => void; transport?: () => string };
  if (demo) {
    source = "demo";
    makeService = () => ({ service: new WalletHistoryService({ providers: [new FixtureHistoryProvider(demoWalletTxs(addr(11)), { maxPageSize: 10 })], cache: new MemoryHistoryCache() }), budget: null, trusted: true });
  } else if (offlineFile) {
    if (wallets.length !== 1) {
      log("--offline attend exactement un wallet");
      return 2;
    }
    let txs: HistoryTx[];
    try {
      const raw = JSON.parse(readFileSync(offlineFile, "utf8")) as HistoryTx[] | { txs: HistoryTx[] };
      txs = Array.isArray(raw) ? raw : raw.txs;
      if (!Array.isArray(txs)) throw new Error("no txs");
    } catch {
      log("fichier hors-ligne illisible");
      return 2;
    }
    source = "offline";
    const trusted = flag(args, "--file-complete");
    makeService = () => ({ service: new WalletHistoryService({ providers: [new FixtureHistoryProvider(txs, { maxPageSize: 25 })], cache: new MemoryHistoryCache() }), budget: null, trusted });
  } else if (live) {
    if (!liveCheck.ok) {
      log(`Essai live REFUSÉ — rien n'a été envoyé :\n${liveCheck.errors.map((e) => `  - ${e}`).join("\n")}`);
      log("Estimation du coût :");
      log(formatEstimate(liveCheck.estimate));
      return 2;
    }
    source = "live";
    const cachePath = join(ctx.config.dir, "cache", "history.json");
    let cache = new MemoryHistoryCache();
    if (existsSync(cachePath)) {
      try {
        cache = cacheFromSnapshot(JSON.parse(readFileSync(cachePath, "utf8")));
      } catch {
        cache = new MemoryHistoryCache();
      }
    }
    if (!ctx.deps.createLiveService) {
      log("Le mode live n'est pas disponible dans ce contexte (fabrique réseau non fournie).");
      return 2;
    }
    const budget = new CallBudget({ maxCalls: maxCalls as number, maxCredits: maxCredits as number });
    log(`Essai LIVE autorisé : ${wallets.length} wallet(s) · budget ${maxCalls} appels / ${maxCredits} crédits estimés · fournisseur ${provider}`);
    for (const w of liveCheck.warnings) log(`  ! ${w}`);
    const made = ctx.deps.createLiveService({ env: ctx.env, budget, provider, cache, pageLimit: l.pageLimit, fetchImpl: ctx.deps.fetchImpl, testRates: ctx.deps.testRates });
    makeService = () => ({ service: made.service, budget, trusted: true, after: () => atomicWriteJson(cachePath, cache.snapshot()), transport: made.transport });
  } else {
    log("Aucun mode choisi : rien n'est envoyé. Utilisez --demo, --offline FILE, --dry-run ou --live (voir `smart-money preflight`).");
    log(formatEstimate(estimateIngest({ wallets: wallets.length, ...l })));
    return 2;
  }

  const json: unknown[] = [];
  let code = 0;
  for (const wallet of wallets) {
    const { service, budget, trusted, after, transport } = makeService(wallet);
    const ingest = await ingestWallet(service, wallet, { ...l, budget: budget ?? undefined, pageCost: budget ? pageCostFor(provider, heliusKeyPresent) : undefined, historyEndTrusted: trusted });
    after?.();
    const { ledger, pnl, profile } = analyzeWallet(wallet, ingest.txs, { coverage: { complete: ingest.complete, oldestTime: ingest.oldestTime }, config: ctx.config });
    const report = buildReport({ ingest, ledger, pnl, profile, source, budget: budget?.report() ?? null, transport: transport?.() ?? null });
    json.push(report);
    if (!flag(args, "--json")) log(formatReport(report));
    if (flag(args, "--save")) {
      await ctx.store.writeSnapshot(`wallet-${walletKey(wallet)}`, report);
      log(`Rapport enregistré : snapshot wallet-${walletKey(wallet)}`);
    }
    if (flag(args, "--emit")) {
      const [r] = await ctx.store.appendEvents([profileEvent(profile, pnl, { now: (ctx.deps.now ?? Date.now)(), criteriaVersion: ctx.config.criteriaVersion, simulated: source === "demo" })]);
      log(`Événement ${r.duplicate ? "déjà présent" : "écrit"} : seq ${r.event.seq}`);
    }
    if (ingest.stopReason === "budget_exhausted" || ingest.stopReason === "error") code = Math.max(code, 1);
    // A provider that rejects us (key, right, quota, rate limit) will reject the next wallet too: stop here, spend nothing more.
    if (live && ingest.stopReason === "error" && wallet !== wallets[wallets.length - 1]) {
      log(`Arrêt : le fournisseur a échoué (${ingest.failureKinds.join(", ") || "erreur"}). Les wallets suivants ne sont pas tentés.`);
      break;
    }
    if (live && ingest.stopReason === "budget_exhausted" && wallet !== wallets[wallets.length - 1]) {
      log("Arrêt : budget épuisé. Les wallets suivants ne sont pas tentés.");
      break;
    }
  }
  if (flag(args, "--json")) log(JSON.stringify(json.length === 1 ? json[0] : json, null, 2));
  return code;
}
