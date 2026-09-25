/**
 * Scores the Solana pairs currently returned by DEX Screener.
 *
 *   npm run score:live            # top 10 by Opportunity Score
 *   npm run score:live -- 20      # top 20
 *
 * Read-only: one scan (same pipeline as the UI), then pure scoring. Prints the
 * ranking, the full breakdown of the top pairs, and data anomalies spotted in
 * the raw values. Nothing here predicts a price.
 */

import { DexScreenerClient } from "../src/api/dexscreener.ts";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { mostLiquidPairPerToken, scanSolana } from "../src/domain/scanner.ts";
import { LABEL_DISCLAIMER } from "../src/scoring/config.ts";
import { CATEGORY_ORDER, scorePairs } from "../src/scoring/score.ts";
import type { ScoredPair } from "../src/scoring/score.ts";

const topN = Number(process.argv[2] ?? 10);
const client = new DexScreenerClient({ baseUrl: process.env.DEXSCREENER_BASE_URL });

const scan = await scanSolana(client);
if (scan.errors.length) {
  console.log("API errors:");
  for (const e of scan.errors) console.log(`  [${e.stage} · ${e.source} · ${e.kind}${e.status ? ` · HTTP ${e.status}` : ""}] ${e.message}`);
}
if (scan.pairs.length === 0) {
  console.log("No pairs returned: nothing to score.");
  process.exit(1);
}

const pairs = mostLiquidPairPerToken(scan.pairs);
const rows = scorePairs(pairs, scan.fetchedAt).sort((a, b) => b.score.opportunity - a.score.opportunity);

const usd = (n: number | null) =>
  n === null ? "—" : `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)}`;
const pct = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
const bs = (b: number | null, s: number | null) => (b === null || s === null ? "—" : `${b}/${s}`);
const age = (m: number | null) => (m === null ? "—" : m < 60 ? `${m.toFixed(0)}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`);
const name = (p: NormalizedPair) => p.tokenSymbol ?? p.tokenAddress.slice(0, 6);

console.log(
  `Scan ${new Date(scan.fetchedAt).toISOString()} · ${scan.pairs.length} pairs → ${pairs.length} tokens (most liquid pair each)\n`,
);

const counts = { WATCH: 0, MOMENTUM: 0, "HIGH RISK": 0, none: 0 };
for (const r of rows) counts[r.score.label ?? "none"]++;
console.log(`Labels: MOMENTUM ${counts.MOMENTUM} · WATCH ${counts.WATCH} · HIGH RISK ${counts["HIGH RISK"]} · none ${counts.none}`);
console.log(`(${LABEL_DISCLAIMER})\n`);

console.table(
  rows.slice(0, topN).map(({ pair: p, score: s }) => ({
    token: name(p),
    opp: s.opportunity,
    risk: s.risk,
    label: s.label ?? "",
    mom: s.categories.momentum.points,
    vol: s.categories.volume.points,
    buyP: s.categories.buyPressure.points,
    liq: s.categories.liquidity.points,
    mcap: s.categories.marketCap.points,
    age: s.categories.age.points,
    "b/s 5m": bs(p.buysM5, p.sellsM5),
    "b/s 1h": bs(p.buysH1, p.sellsH1),
    "Δ5m": pct(p.priceChangeM5),
    "Δ1h": pct(p.priceChangeH1),
    liqUsd: usd(p.liquidityUsd),
    mcapUsd: usd(p.marketCap),
    pairAge: age(s.ageMinutes),
    dex: p.dexId ?? "—",
  })),
);

for (const [i, { pair: p, score: s }] of rows.slice(0, topN).entries()) {
  console.log(`\n#${i + 1} ${name(p)} (${p.tokenName ?? "—"}) — ${p.url ?? p.pairAddress}`);
  console.log(`   Pourquoi ${s.opportunity}/100 ? (somme exacte ${s.opportunityExact}) · Risk ${s.risk}/100 · ${s.label ?? "sans étiquette"} — ${s.labelReason}`);
  for (const k of CATEGORY_ORDER) {
    const c = s.categories[k];
    console.log(`   ${c.label.padEnd(13)} ${String(c.points).padStart(5)} / ${c.max}${c.cap ? `   ⚠ ${c.cap.reason}` : ""}`);
    for (const it of c.items) {
      console.log(`     · ${it.label.padEnd(28)} ${String(it.points).padStart(4)} / ${it.max}  ${it.input}${it.note ? `  — ${it.note}` : ""}`);
    }
  }
  console.log(`   Risk factors: ${s.riskFactors.length ? s.riskFactors.map((f) => `${f.label} +${f.points} (${f.input})`).join(" · ") : "aucun"}`);
}

// ─── anomalies in the raw data ─────────────────────────────────────────────

function anomalies({ pair: p, score: s }: ScoredPair): string[] {
  const out: string[] = [];
  if (p.liquidityUsd === null) out.push(`liquidity.usd absent (dex ${p.dexId})`);
  if (p.liquidityUsd !== null && p.marketCap !== null && p.liquidityUsd > p.marketCap)
    out.push(`liquidité ${usd(p.liquidityUsd)} > market cap ${usd(p.marketCap)}`);
  if (p.liquidityUsd && p.volumeH1 !== null && p.volumeH1 / p.liquidityUsd > 10)
    out.push(`volume 1 h = ${(p.volumeH1 / p.liquidityUsd).toFixed(0)}× la liquidité`);
  if (p.priceChangeH1 !== null && Math.abs(p.priceChangeH1) >= 90) out.push(`Δ1h ${pct(p.priceChangeH1)}`);
  if (p.priceChangeM5 !== null && Math.abs(p.priceChangeM5) >= 30) out.push(`Δ5m ${pct(p.priceChangeM5)}`);
  if (p.priceChangeM5 === null && p.volumeM5 === 0) out.push("priceChange.m5 absent et volume 5 min = 0 (aucun trade récent)");
  else if (p.priceChangeM5 === null) out.push("priceChange.m5 absent");
  if (p.priceChangeH1 === null) out.push("priceChange.h1 absent");
  const txM5 = p.buysM5 !== null && p.sellsM5 !== null ? p.buysM5 + p.sellsM5 : null;
  if (txM5 !== null && txM5 >= 20 && p.buysM5! / txM5 >= 0.9) out.push(`5 min : ${p.buysM5} achats / ${p.sellsM5} ventes (≥ 90 % achats)`);
  if (txM5 !== null && txM5 >= 20 && p.sellsM5! / txM5 >= 0.85) out.push(`5 min : ${p.sellsM5} ventes / ${p.buysM5} achats (≥ 85 % ventes)`);
  if (p.volumeH1 && p.buysH1 !== null && p.sellsH1 !== null && p.buysH1 + p.sellsH1 > 0) {
    const avg = p.volumeH1 / (p.buysH1 + p.sellsH1);
    if (avg < 5) out.push(`ticket moyen 1 h ${usd(avg)} (possibles micro-transactions de bots)`);
  }
  if (s.ageMinutes !== null && s.ageMinutes < 60 && p.volumeH1 !== null && p.volumeH1 === p.volumeH24)
    out.push(`paire de ${age(s.ageMinutes)} : volume 1 h = 6 h = 24 h (fenêtres identiques)`);
  if (p.marketCap !== null && p.fdv !== null && Math.abs(p.marketCap - p.fdv) / p.fdv > 0.05)
    out.push(`market cap ${usd(p.marketCap)} ≠ FDV ${usd(p.fdv)}`);
  return out;
}

console.log("\n─── Anomalies observées dans les données brutes ───");
let any = false;
for (const r of rows) {
  const a = anomalies(r);
  if (!a.length) continue;
  any = true;
  console.log(`  ${name(r.pair).padEnd(12)} opp ${String(r.score.opportunity).padStart(3)} risk ${String(r.score.risk).padStart(3)} : ${a.join(" · ")}`);
}
if (!any) console.log("  aucune");
