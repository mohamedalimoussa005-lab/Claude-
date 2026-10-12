/**
 * DETECTIVE — analyse one Solana token address and write a single report (read-only).
 *
 *   npm run detective -- <MINT> [--mode rapide|standard|profond] [--out DIR] [--max-calls N] [--max-seconds N] [--helius] [--quiet]
 *
 * Default: public Solana RPC + DEX Screener public API (no key, no paid service). `--helius` uses the server-side
 * Helius key from the environment ONLY if you pass it explicitly (quota not verified by default). Nothing is signed,
 * sent or traded. Output: report.md, report.json, ledger.json in DIR/detective-<mint>-<time>/.
 * Behind a proxy, start Node with NODE_USE_ENV_PROXY=1.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DexScreenerClient } from "../src/api/dexscreener.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { SolanaRpc } from "../src/onchain/rpc.ts";
import { createServerSolanaRpc } from "../src/rpc/serverRpc.ts";
import { newMeter, runDetective } from "../src/detective/run.ts";
import { parseMode, withMode } from "../src/detective/modes.ts";
import type { ReadRpc } from "../src/detective/meter.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = ["--mode", "--out", "--max-calls", "--max-seconds"];
const mint = args.find((a, i) => !a.startsWith("--") && (i === 0 || !VALUE_FLAGS.includes(args[i - 1]!)));
if (!mint || flag("help")) {
  console.log("usage: npm run detective -- <MINT> [--mode rapide|standard|profond] [--out DIR] [--max-calls N] [--max-seconds N] [--helius] [--quiet]");
  process.exit(flag("help") ? 0 : 2);
}

const mode = parseMode(val("mode"));
const cfg = withMode(mode, {
  ...(val("max-calls") ? { maxCalls: Number(val("max-calls")) } : {}),
  ...(val("max-seconds") ? { maxMs: Number(val("max-seconds")) * 1000 } : {}),
});
const meter = newMeter(cfg);

let rpc: ReadRpc;
let providerLabel = "public_rpc";
if (flag("helius")) {
  const s = createServerSolanaRpc({ env: process.env, onRequest: (e) => meter.onRequest(e) });
  rpc = s.rpc as unknown as ReadRpc;
  providerLabel = s.providers.join(" → ");
} else {
  rpc = new SolanaRpc({ config: ONCHAIN_CONFIG, onRequest: meter.onRequest }) as unknown as ReadRpc;
}

console.error(`DETECTIVE · mode ${mode} · budget ${cfg.maxCalls} appels / ${Math.round(cfg.maxMs / 1000)} s · RPC ${providerLabel} · lecture seule`);
const result = await runDetective({ mint, mode, overrides: { maxCalls: cfg.maxCalls, maxMs: cfg.maxMs } }, { dex: new DexScreenerClient(), rpc, meter });

const dir = join(val("out") ?? "detective-reports", `detective-${mint.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.md"), result.markdown);
writeFileSync(join(dir, "report.json"), JSON.stringify(result.report, null, 2));
writeFileSync(join(dir, "ledger.json"), JSON.stringify(result.ledger.toJSON(), null, 2));
if (!flag("quiet")) console.log(result.markdown);
const b = result.report.budget;
console.error(`\nRapport écrit dans ${dir}/ (report.md, report.json, ledger.json) · ${b.calls} appels, ${(b.elapsedMs / 1000).toFixed(0)} s, limites: ${b.limitsReached.length ? b.limitsReached.join(" ; ") : "aucune"}`);
