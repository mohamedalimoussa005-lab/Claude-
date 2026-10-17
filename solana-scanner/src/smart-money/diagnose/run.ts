import { DEFAULT_THRESHOLDS } from "../config.ts";
import type { SmartMoneyThresholds } from "../config.ts";
import { buildLedger } from "../ledger/build.ts";
import { computePnl } from "../pnl/fifo.ts";
import { estimateDepth } from "./depth.ts";
import { txsOf } from "./load.ts";
import type { LocalData } from "./load.ts";
import { findOrphans } from "./orphans.ts";
import { reconcile } from "./reconcile.ts";
import { diagnoseRent } from "./rent.ts";
import { DIAGNOSE_SCHEMA } from "./types.ts";
import type { DiagnosticReport } from "./types.ts";
import { describeWindow, iso } from "./window.ts";

export interface DiagnoseOptions {
  thresholds?: SmartMoneyThresholds;
  tipAccounts?: string[];
  now: number;
  /** Transactions per wallet an extension would aim for. */
  targetTransactions?: number;
}

export function diagnoseWallet(wallet: string, local: LocalData, o: DiagnoseOptions): DiagnosticReport {
  const thresholds = o.thresholds ?? DEFAULT_THRESHOLDS;
  const txs = txsOf(local, wallet);
  const saved = local.reports.find((r) => r.report.wallet === wallet) ?? null;
  const report = saved?.report ?? null;
  const origin = local.cache.snapshot?.origins?.find((x) => x.wallet === wallet);

  const win = describeWindow(txs, report, origin, saved?.writtenAt ?? null);
  const ledger = buildLedger(wallet, txs, { thresholds, tipAccounts: o.tipAccounts });
  const coverage = { complete: report?.history.complete ?? false, oldestTime: win.oldest?.time ?? null };
  const engine = computePnl(ledger, { coverage, thresholds });
  const orphans = findOrphans(ledger, engine, win.oldest?.time ?? null, thresholds.dustRatio);
  const rent = diagnoseRent(ledger, wallet, local.cache.bySignature);
  const depth = estimateDepth(orphans.groups, engine, win, o.targetTransactions ?? 1000);
  const reconciliation = reconcile(report, txs);

  const sources: DiagnosticReport["sources"] = {
    status: local.cache.readable ? (report ? "ok" : "partial") : "impossible",
    reason: !local.cache.present ? "cache/history.json introuvable" : !local.cache.readable ? "cache illisible" : report ? undefined : "aucun rapport wallet-*.json pour ce wallet",
    cache: { present: local.cache.present, readable: local.cache.readable, txsInCache: local.cache.bySignature.size, txsForWallet: txs.length },
    report: { present: !!report, name: saved?.name ?? null, writtenAt: iso(saved?.writtenAt ?? null) },
    filesRead: local.filesRead,
    problems: local.problems,
  };

  const impossible: DiagnosticReport["impossible"] = [];
  const note = (section: string, s: { status: string; reason?: string }) => {
    if (s.status !== "ok") impossible.push({ section, reason: s.reason ?? s.status });
  };
  note("sources", sources);
  note("fenêtre", win);
  note("réconciliation", reconciliation);
  note("ventes sans achat", orphans);
  note("rent", rent);
  note("profondeur", depth);
  if (orphans.groups.length > 0) impossible.push({ section: "recherche ciblée par token", reason: "les adresses des comptes de token ne sont pas conservées dans le cache : impossible de préparer une recherche par compte depuis ces données" });
  if (orphans.sameSlot.length > 0) impossible.push({ section: "ordre dans un slot", reason: "l'ordre réel des transactions à l'intérieur d'un même slot n'est pas dans les données (seul le slot l'est)" });
  if (!report) impossible.push({ section: "complétude de la collecte", reason: "sans rapport enregistré, l'arrêt de la collecte (pages, budget…) est inconnu" });

  return { schema: DIAGNOSE_SCHEMA, generatedAt: new Date(o.now).toISOString(), readOnly: true, network: false, wallet, sources, window: win, reconciliation, orphans, rent, depth, impossible };
}

/** Defence in depth: nothing that looks like a key may leave in a report. */
export function assertNoSecrets(text: string, env: Record<string, string | undefined>): void {
  if (/api-key=/i.test(text)) throw new Error("report refused: contains an api-key parameter");
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) throw new Error("report refused: contains a key-shaped identifier");
  for (const [k, v] of Object.entries(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(k) && v && v.length >= 8 && text.includes(v)) throw new Error("report refused: contains a secret from the environment");
}
