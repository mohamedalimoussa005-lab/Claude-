import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Writes an exported report. Never into the data directory, never over an existing file unless --overwrite.
 * Returns a process exit code on refusal, null when written (or when no --out was given).
 */
export function writeJsonOut(args: string[], dataDir: string, json: string, log: (s: string) => void): number | null {
  const i = args.indexOf("--out");
  if (i < 0) return null;
  const out = args[i + 1];
  if (!out) {
    log("--out attend un chemin");
    return 2;
  }
  const target = resolve(out);
  if (!relative(resolve(dataDir), target).startsWith("..")) {
    log("--out ne peut pas pointer dans le dossier de données (lecture seule).");
    return 2;
  }
  if (existsSync(target) && !args.includes("--overwrite")) {
    log("--out existe déjà : ajoutez --overwrite pour le remplacer.");
    return 2;
  }
  writeFileSync(target, `${json}\n`, { mode: 0o600 });
  log(`Rapport JSON écrit : ${out}`);
  return null;
}
