/**
 * `compare`: the cached transactions of a wallet through the old (v1, frozen) and the new (v2) engine, side by side.
 * Offline and read-only, like `diagnose`.
 *
 *   compare [--wallet ADDR] [--dir DIR] [--json] [--out FILE [--overwrite]] [--all]
 */

import type { SmartMoneyConfig } from "../config.ts";
import { compareWallet } from "../compare/compare.ts";
import { formatComparison } from "../compare/format.ts";
import { loadLocalData, walletsIn } from "../diagnose/load.ts";
import { assertNoSecrets } from "../diagnose/run.ts";
import { writeJsonOut } from "./outFile.ts";

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

export async function compareCommand(args: string[], ctx: Ctx): Promise<number> {
  const dir = opt(args, "--dir") ?? ctx.config.dir;
  const local = loadLocalData(dir);
  const wanted = opt(args, "--wallet");
  const wallets = wanted ? [wanted] : walletsIn(local);
  if (wallets.length === 0) {
    ctx.log(`Aucune donnée locale dans ${dir} (cache/history.json et snapshots/wallet-*.json). Rien à comparer — aucun réseau n'est utilisé.`);
    for (const p of local.problems) ctx.log(`  ! ${p}`);
    return 2;
  }
  const reports = wallets.map((w) => compareWallet(w, local, { thresholds: ctx.config.thresholds, tipAccounts: ctx.config.tipAccounts, now: (ctx.now ?? Date.now)() }));
  const json = JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2);
  const text = reports.map((r) => formatComparison(r, { all: args.includes("--all") })).join("\n\n");
  try {
    assertNoSecrets(json + text, ctx.env);
  } catch (e) {
    ctx.log(`Rapport refusé : ${(e as Error).message}`);
    return 1;
  }
  const refused = writeJsonOut(args, dir, json, ctx.log);
  if (refused !== null) return refused;
  ctx.log(args.includes("--json") ? json : text);
  return 0;
}
