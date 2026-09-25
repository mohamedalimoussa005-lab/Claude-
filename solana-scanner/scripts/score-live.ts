/**
 * Scores the Solana pairs currently returned by DEX Screener.
 *
 *   npm run score:live            # top 10 by Opportunity Score
 *   npm run score:live -- 20      # top 20
 *
 * Read-only: one scan (same pipeline as the UI), then pure scoring. Prints the
 * ranking with Opportunity / Risk / Quality / Confidence, the full breakdown of
 * the top pairs, and every anomaly detected. Nothing here predicts a price.
 */

import { DexScreenerClient } from "../src/api/dexscreener.ts";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { mostLiquidPairPerToken, scanSolana } from "../src/domain/scanner.ts";
import { LABEL_DISCLAIMER } from "../src/scoring/config.ts";
import { CATEGORY_ORDER, scorePairs } from "../src/scoring/score.ts";

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
    quality: s.quality,
    conf: s.confidence.level,
    label: s.label ?? "",
    mom: s.categories.momentum.points,
    vol: s.categories.volume.points,
    buyP: s.categories.buyPressure.points,
    liq: s.categories.liquidity.points,
    mcap: s.categories.marketCap.points,
    age: s.categories.age.points,
    "b/s 5m": bs(p.buysM5, p.sellsM5),
    "b/s 1h": bs(p.buysH1, p.sellsH1),
    "Δ1h": pct(p.priceChangeH1),
    liqUsd: usd(p.liquidityUsd),
    pairAge: age(s.ageMinutes),
  })),
);

for (const [i, { pair: p, score: s }] of rows.slice(0, topN).entries()) {
  console.log(`\n#${i + 1} ${name(p)} (${p.tokenName ?? "—"}) — ${p.url ?? p.pairAddress}`);
  console.log(
    `   Opportunity ${s.opportunity}/100 · Risk ${s.risk}/100 · Quality ${s.quality}/100 · Confidence ${s.confidence.level}` +
      `${s.confidence.caps.length ? ` (${s.confidence.caps.join(", ")})` : ""} · ${s.label ?? "sans étiquette"} — ${s.labelReason}`,
  );
  console.log(`   + ${s.signals.positive.join("\n   + ") || "aucun signal positif marqué"}`);
  console.log(`   − ${s.signals.negative.join("\n   − ") || "aucun signal négatif marqué"}`);
  console.log(`   ⚠ ${s.signals.anomalies.map((a) => `${a.title} (${a.detail})`).join("\n   ⚠ ") || "aucune anomalie"}`);
  for (const k of CATEGORY_ORDER) {
    const c = s.categories[k];
    console.log(`   ${c.label.padEnd(13)} ${String(c.points).padStart(5)} / ${c.max}${c.cap ? `   ⚠ ${c.cap.reason}` : ""}`);
    for (const it of c.items) {
      console.log(`     · ${it.label.padEnd(28)} ${String(it.points).padStart(4)} / ${it.max}  ${it.input}${it.note ? `  — ${it.note}` : ""}`);
    }
  }
  console.log(`   Risk factors: ${s.riskFactors.length ? s.riskFactors.map((f) => `${f.label} +${f.points} (${f.input})`).join(" · ") : "aucun"}`);
}

// ─── anomalies ──────────────────────────────────────────────────────────────

console.log("\n─── Anomalies détectées (tous les tokens) ───");
let any = false;
for (const { pair: p, score: s } of rows) {
  if (!s.signals.anomalies.length) continue;
  any = true;
  console.log(
    `  ${name(p).padEnd(12)} opp ${String(s.opportunity).padStart(3)} risk ${String(s.risk).padStart(3)} quality ${String(s.quality).padStart(3)} ${s.confidence.level.padEnd(6)} : ${s.signals.anomalies.map((a) => a.title).join(" · ")}`,
  );
}
if (!any) console.log("  aucune");
