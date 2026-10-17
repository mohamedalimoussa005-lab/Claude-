/**
 * `diagnose`: offline, read-only diagnostic of what a previous collection left on disk. No network, no lock, no write
 * to the data directory. The only file this command can write is the one named by --out (never an existing file unless
 * --overwrite, never inside the data directory).
 *
 *   diagnose [--wallet ADDR] [--dir DIR] [--json] [--out FILE [--overwrite]] [--all] [--target-tx N]
 */

import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { SmartMoneyConfig } from "../config.ts";
import { loadLocalData, walletsIn } from "../diagnose/load.ts";
import { assertNoSecrets, diagnoseWallet } from "../diagnose/run.ts";
import { formatDiagnostic } from "../diagnose/format.ts";

interface Ctx {
  config: SmartMoneyConfig;
  env: Record<string, string | undefined>;
  log: (s: string) => void;
  now?: () => number;
}

const opt = (a: string[], n: string) => {
  const i = a.indexOf(n);
  return i >= 0 ? a[i + 1] : undefined;
};

export async function diagnoseCommand(args: string[], ctx: Ctx): Promise<number> {
  const dir = opt(args, "--dir") ?? ctx.config.dir;
  const target = opt(args, "--target-tx") === undefined ? 1000 : Number(opt(args, "--target-tx"));
  if (!Number.isFinite(target) || target <= 0) {
    ctx.log("--target-tx doit être un nombre positif");
    return 2;
  }
  const local = loadLocalData(dir);
  const found = walletsIn(local);
  const wanted = opt(args, "--wallet");
  const wallets = wanted ? [wanted] : found;
  if (wallets.length === 0) {
    ctx.log(`Aucune donnée locale dans ${dir} (cache/history.json et snapshots/wallet-*.json). Rien à diagnostiquer — aucun réseau n'est utilisé.`);
    for (const p of local.problems) ctx.log(`  ! ${p}`);
    return 2;
  }
  const reports = wallets.map((w) => diagnoseWallet(w, local, { thresholds: ctx.config.thresholds, tipAccounts: ctx.config.tipAccounts, now: (ctx.now ?? Date.now)(), targetTransactions: target }));
  const json = JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2);
  const text = reports.map((r) => formatDiagnostic(r, { all: args.includes("--all") })).join("\n\n");
  try {
    assertNoSecrets(json + text, ctx.env);
  } catch (e) {
    ctx.log(`Rapport refusé : ${(e as Error).message}`);
    return 1;
  }
  const out = opt(args, "--out");
  if (out) {
    const target2 = resolve(out);
    if (!relative(resolve(dir), target2).startsWith("..")) {
      ctx.log("--out ne peut pas pointer dans le dossier de données (lecture seule).");
      return 2;
    }
    if (existsSync(target2) && !args.includes("--overwrite")) {
      ctx.log("--out existe déjà : ajoutez --overwrite pour le remplacer.");
      return 2;
    }
    writeFileSync(target2, `${json}\n`, { mode: 0o600 });
    ctx.log(`Rapport JSON écrit : ${out}`);
  }
  ctx.log(args.includes("--json") ? json : text);
  return 0;
}
