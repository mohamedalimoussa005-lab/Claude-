/**
 * DETECTIVE Social Radar — news first (free sources only, read-only).
 *
 *   npm run radar -- [--top N] [--detective N] [--min-strength 1-5] [--max-requests N] [--max-seconds N]
 *                    [--detective-calls N] [--no-gdelt] [--out DIR] [--quiet]
 *
 * Reads public RSS feeds, Google News RSS and GDELT, groups articles into stories, looks for Solana tokens on DEX Screener
 * and forwards the strongest candidates to DETECTIVE (mode rapide). No X post is read (paid API unused, no scraping).
 * Cost: 0 $. Behind a proxy, start Node with NODE_USE_ENV_PROXY=1.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DexScreenerClient } from "../src/api/dexscreener.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { SolanaRpc } from "../src/onchain/rpc.ts";
import { newMeter, runDetective } from "../src/detective/run.ts";
import { withMode } from "../src/detective/modes.ts";
import type { ReadRpc } from "../src/detective/meter.ts";
import { RADAR_DEFAULTS, renderRadarMarkdown, runRadar } from "../src/detective/social-radar/index.ts";
import type { DetectiveRunner } from "../src/detective/social-radar/index.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag("help")) {
  console.log("usage: npm run radar -- [--top N] [--detective N] [--min-strength 1-5] [--max-requests N] [--max-seconds N] [--detective-calls N] [--no-gdelt] [--out DIR] [--quiet]");
  process.exit(0);
}
const num = (n: string, d: number): number => {
  const v = val(n);
  if (v === undefined) return d;
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) throw new Error(`--${n} doit être un nombre positif`);
  return x;
};

const opts = {
  ...RADAR_DEFAULTS,
  maxStories: num("top", RADAR_DEFAULTS.maxStories),
  detectiveTop: num("detective", RADAR_DEFAULTS.detectiveTop),
  minStrength: num("min-strength", RADAR_DEFAULTS.minStrength),
  maxRequests: num("max-requests", RADAR_DEFAULTS.maxRequests),
  maxMs: num("max-seconds", RADAR_DEFAULTS.maxMs / 1000) * 1000,
  gdeltStories: flag("no-gdelt") ? 0 : RADAR_DEFAULTS.gdeltStories,
};
const dex = new DexScreenerClient();
const detectiveCalls = num("detective-calls", 150);

const detective: DetectiveRunner = async (mint) => {
  const cfg = withMode("rapide", { maxCalls: detectiveCalls });
  const meter = newMeter(cfg);
  const rpc = new SolanaRpc({ config: ONCHAIN_CONFIG, onRequest: meter.onRequest }) as unknown as ReadRpc;
  const r = await runDetective({ mint, mode: "rapide", overrides: { maxCalls: cfg.maxCalls } }, { dex, rpc, meter });
  const s = r.report.sections;
  const pick = [...s.synthesis.findings.slice(0, 8)];
  return { mint, mode: "rapide", calls: r.report.budget.calls, elapsedMs: r.report.budget.elapsedMs, limitsReached: r.report.budget.limitsReached, status: "done", reason: null, findings: pick, unknowns: [...s.liquidity.unknowns, ...s.identity.unknowns].slice(0, 6) };
};

console.error(`Social Radar · news first · ${opts.maxRequests} requêtes / ${Math.round(opts.maxMs / 1000)} s · DETECTIVE sur ${opts.detectiveTop} candidat(s) · coût 0 $`);
const { report, ledger } = await runRadar(opts, { fetch: (u, i) => globalThis.fetch(u, i), dex, detective: opts.detectiveTop > 0 ? detective : undefined });
const md = renderRadarMarkdown(report);
const dir = join(val("out") ?? "detective-reports", `radar-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "radar.md"), md);
writeFileSync(join(dir, "radar.json"), JSON.stringify(report, null, 2));
writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger.ledger.toJSON(), null, 2));
if (!flag("quiet")) console.log(md);
console.error(`\nRapport écrit dans ${dir}/ (radar.md, radar.json, ledger.json) · ${report.budget.requests} requêtes · ${report.stories.length} sujet(s) · ${report.candidates.length} candidat(s)`);
