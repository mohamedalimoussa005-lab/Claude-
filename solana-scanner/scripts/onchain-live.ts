/**
 * Real on-chain check of the current best scanner candidates.
 *
 *   npm run onchain:live          # the configured number of candidates (5)
 *   npm run onchain:live -- 3
 *
 * Pipeline: DEX Screener scan → Opportunity / Risk / Quality → candidate
 * selection → on-chain analysis (public Solana RPC, read-only). Prints both
 * risk systems side by side; no combined score.
 */

import { DexScreenerClient } from "../src/api/dexscreener.ts";
import { mostLiquidPairPerToken, scanSolana } from "../src/domain/scanner.ts";
import { ONCHAIN_CONFIG, ONCHAIN_DISCLAIMER } from "../src/onchain/config.ts";
import { SolanaRpc } from "../src/onchain/rpc.ts";
import type { RpcLogEntry } from "../src/onchain/rpc.ts";
import { OnchainService, selectCandidates } from "../src/onchain/service.ts";
import { scorePairs } from "../src/scoring/score.ts";

const count = Number(process.argv[2] ?? ONCHAIN_CONFIG.candidates.max);
const log: RpcLogEntry[] = [];
const rpc = new SolanaRpc({ url: process.env.SOLANA_RPC_URL, onRequest: (e) => log.push(e) });
const service = new OnchainService(rpc, { ...ONCHAIN_CONFIG, candidates: { ...ONCHAIN_CONFIG.candidates, max: count } });

const scan = await scanSolana(new DexScreenerClient());
const rows = scorePairs(mostLiquidPairPerToken(scan.pairs), scan.fetchedAt);
const candidates = selectCandidates(rows, { ...ONCHAIN_CONFIG, candidates: { ...ONCHAIN_CONFIG.candidates, max: count } });
console.log(`Scan ${new Date(scan.fetchedAt).toISOString()} · ${rows.length} tokens · ${candidates.length} candidats on-chain (RPC ${rpc.url})\n`);

const pct = (n: number | undefined | null) => (n === null || n === undefined ? "UNKNOWN" : `${n.toFixed(2)} %`);

for (const [i, row] of candidates.entries()) {
  const t0 = Date.now();
  const before = log.length;
  const { data, analysis: a } = await service.analyze(row);
  const calls = log.slice(before).filter((e) => e.outcome !== "cache" && e.attempt >= 1).length;
  const s = row.score;
  const h = a.holders;
  console.log(`══ #${i + 1} ${row.pair.tokenSymbol} — ${row.pair.tokenAddress} (${row.pair.dexId}, pair ${row.pair.pairAddress})`);
  console.log(`   DEX Screener : Opportunity ${s.opportunity} · DEX Risk ${s.risk} · Quality ${s.quality} · Confidence ${s.confidence.level}${s.label ? ` · ${s.label}` : ""}`);
  console.log(`   On-chain     : Risk ${a.risk}/100 · Confidence ${a.confidence} (${a.confidencePoints}/100) · ${calls} appels RPC, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`   Mint authority ${a.mintAuthority}${a.mintAuthorityAddress ? ` (${a.mintAuthorityAddress})` : ""} · Freeze authority ${a.freezeAuthority}${a.freezeAuthorityAddress ? ` (${a.freezeAuthorityAddress})` : ""} · programme ${a.tokenProgram ?? "UNKNOWN"}`);
  if (h) {
    console.log(`   Holders ${h.holderCount} (${h.tokenAccounts} comptes) · RAW top1/5/10/20 ${pct(h.raw.top1)} / ${pct(h.raw.top5)} / ${pct(h.raw.top10)} / ${pct(h.raw.top20)}`);
    console.log(`   ADJUSTED top1/5/10/20 ${h.adjusted ? `${pct(h.adjusted.top1)} / ${pct(h.adjusted.top5)} / ${pct(h.adjusted.top10)} / ${pct(h.adjusted.top20)}` : "impossible"} · exclus : ${h.excluded.map((e) => `${e.class.label} ${pct(e.pctOfSupply)}`).join(", ") || "aucun"}`);
  } else console.log("   Holders UNKNOWN");
  console.log(`   ${a.creatorNote}`);
  if (data.creatorActivity.status === "ok") {
    const c = data.creatorActivity.value;
    console.log(`     SOL ${c.solBalance.toFixed(3)} · tokens ${pct(c.tokenPct)} · ${c.analyzedTransactions} tx analysées · événements : ${c.events.map((e) => `${e.kind} ${e.tokenDeltaPct.toFixed(2)}%`).join(", ") || "aucun"}`);
  }
  console.log(`   Catégories : ${a.categories.map((c) => `${c.label} ${c.points}/${c.max}`).join(" · ")}`);
  console.log(`   RED FLAGS:\n     - ${a.redFlags.join("\n     - ") || "aucun"}`);
  console.log(`   POSITIVE STRUCTURAL SIGNALS:\n     - ${a.positives.join("\n     - ") || "aucun"}`);
  console.log(`   UNKNOWN / NOT VERIFIED:\n     - ${a.unknowns.join("\n     - ") || "aucun"}\n`);
}

const byOutcome = log.reduce<Record<string, number>>((acc, e) => ((acc[e.outcome] = (acc[e.outcome] ?? 0) + 1), acc), {});
console.log(`RPC : ${JSON.stringify(byOutcome)}`);
console.log(`\n${ONCHAIN_DISCLAIMER}`);
