/**
 * Real wallet-intelligence check on the current best candidates.
 *
 *   npm run wallets:live          # 5 candidates (slow: the free RPC serves ~1 tx/s)
 *   npm run wallets:live -- 2
 *
 * Pipeline: DEX Screener → scores → candidates → on-chain validation → wallet
 * discovery → shortlist → wallet facts / bounded history. No combined score.
 */

import { DexScreenerClient } from "../src/api/dexscreener.ts";
import { mostLiquidPairPerToken, scanSolana } from "../src/domain/scanner.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { SolanaRpc } from "../src/onchain/rpc.ts";
import type { RpcLogEntry } from "../src/onchain/rpc.ts";
import { OnchainService, selectCandidates } from "../src/onchain/service.ts";
import { scorePairs } from "../src/scoring/score.ts";
import { WALLET_DISCLAIMER } from "../src/wallets/config.ts";
import type { WalletIntel } from "../src/wallets/intel.ts";
import { WalletIntelService } from "../src/wallets/service.ts";

const count = Number(process.argv[2] ?? ONCHAIN_CONFIG.candidates.max);
const log: RpcLogEntry[] = [];
const rpc = new SolanaRpc({ url: process.env.SOLANA_RPC_URL, onRequest: (e) => log.push(e) });
const dex = new DexScreenerClient();
const onchain = new OnchainService(rpc);
const wallets = new WalletIntelService(rpc, dex);

const scan = await scanSolana(dex);
const rows = scorePairs(mostLiquidPairPerToken(scan.pairs), scan.fetchedAt);
const candidates = selectCandidates(rows, { ...ONCHAIN_CONFIG, candidates: { ...ONCHAIN_CONFIG.candidates, max: count } });
console.log(`Scan ${new Date(scan.fetchedAt).toISOString()} · ${candidates.length} candidats\n`);

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const ago = (t: number | null) => (t === null ? "?" : `${Math.round((Date.now() - t) / 60_000)} min`);
const pctFmt = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)} %`);
const results: { symbol: string; intel: WalletIntel }[] = [];

for (const row of candidates) {
  const t0 = Date.now();
  const before = log.filter((e) => e.outcome === "ok").length;
  const oc = await onchain.analyze(row);
  const intel = await wallets.analyze(row, oc);
  results.push({ symbol: row.pair.tokenSymbol ?? row.pair.tokenAddress, intel });
  const calls = log.filter((e) => e.outcome === "ok").length - before;
  const s = intel.scan;
  console.log(`══ ${row.pair.tokenSymbol} — ${row.pair.tokenAddress}`);
  console.log(`   Opportunity ${row.score.opportunity} · DEX Risk ${row.score.risk} · Quality ${row.score.quality} · On-chain Risk ${oc.analysis.risk} (${oc.analysis.confidence})`);
  console.log(`   ${calls} appels RPC, ${((Date.now() - t0) / 1000).toFixed(0)} s · ${s.signaturesScanned} signatures du mint parcourues, lancement ${s.launchReachable ? `atteint (${s.launch?.time ? new Date(s.launch.time).toISOString().slice(11, 19) : "?"} UTC)` : "HORS DE PORTÉE"}`);
  console.log(`   WALLET INTELLIGENCE : acheteurs identifiés ${intel.buyersIdentified} · suivis ${intel.tracked.length} · clusters indépendants ${intel.independentClusters} · historiques reconstruits ${intel.historiesReconstructed} · high-quality ${intel.highQuality} · Confidence HIGH ${intel.highConfidence}`);
  if (intel.creatorBuys) console.log(`   Deployment-associated wallet : a acheté ${intel.creatorBuys.tokenPct?.toFixed(1) ?? "?"} % de l'offre pour ${intel.creatorBuys.sol.toFixed(2)} SOL au lancement${intel.creatorBuys.inLaunchSlot ? " (bloc de création)" : ""}`);
  console.log(`   Acheteurs dans le bloc de création (hors deployment wallet) : ${s.launchReachable ? intel.launchSlotBuyers : "UNKNOWN"}`);
  console.log(`   Inflow des wallets suivis (échantillon) : ${intel.trackedInflowSol.toFixed(2)} SOL ≈ $${intel.trackedInflowUsdEst?.toFixed(0) ?? "?"} (estimé)`);
  console.log(`   Entrées récentes : ${intel.recentEntries.slice(0, 5).map((e) => `${short(e.address)} — ${ago(e.time)} (${e.sol.toFixed(2)} SOL, cluster ${e.cluster ?? "-"})`).join(" · ") || "aucune"}`);
  for (const t of intel.tracked) {
    const p = t.profile;
    const m = p.metrics;
    console.log(
      `   - ${short(t.address)} cluster ${t.cluster} · entrée ${t.entryMinutesAfterLaunch === null ? "?" : `+${t.entryMinutesAfterLaunch.toFixed(1)} min`}${t.sameSlotAsLaunch ? " (MÊME BLOC que la création)" : ""} · mcap entrée ${t.entryMcapUsdEst ? `$${(t.entryMcapUsdEst / 1000).toFixed(1)}k est.` : "?"} · ${t.solSpent.toFixed(2)} SOL · détient ${t.currentPct === null ? "?" : `${t.currentPct.toFixed(2)} %`}` +
        ` · WQ ${p.quality} ${p.confidence} · ${p.facts.signatureCount >= 5000 ? "≥5000" : p.facts.signatureCount} tx · trades ${m ? `${m.evaluated} (${m.profitable} rentables, médiane ${pctFmt(m.medianReturn)})` : "UNKNOWN"}` +
        `${p.flags.length ? ` · ⚑ ${p.flags.map((f) => f.label).join(", ")}` : ""}`,
    );
  }
  for (const g of intel.related.groups) console.log(`   Potentially related: ${g.members.map((m) => short(m.address)).join(", ")} — ${g.reasons.join(" ; ")}`);
  for (const n of intel.notes) console.log(`   note: ${n}`);
  console.log("");
}

// Cross-token recurrence among identified buyers
const seen = new Map<string, string[]>();
for (const { symbol, intel } of results) {
  const addrs = new Set([...intel.scan.earlyTrades, ...intel.scan.recentTrades].filter((t) => t.side === "buy").map((t) => t.owner));
  for (const a of addrs) seen.set(a, [...(seen.get(a) ?? []), symbol]);
}
const multi = [...seen].filter(([, s]) => s.length > 1);
console.log(`Wallets acheteurs présents sur plusieurs candidats : ${multi.length ? multi.map(([a, s]) => `${short(a)} (${s.join(", ")})`).join(" · ") : "aucun"}`);

const tot = (f: (i: WalletIntel) => number) => results.reduce((s, r) => s + f(r.intel), 0);
console.log(`\nTOTAL : acheteurs identifiés ${tot((i) => i.buyersIdentified)} · suivis ${tot((i) => i.tracked.length)} · historiques reconstruits ${tot((i) => i.historiesReconstructed)} · Confidence HIGH ${tot((i) => i.highConfidence)} · wallets ≥5000 tx ${tot((i) => i.tracked.filter((t) => t.profile.facts.signatureCount >= 5000).length)}`);
const byOutcome = log.reduce<Record<string, number>>((acc, e) => ((acc[e.outcome] = (acc[e.outcome] ?? 0) + 1), acc), {});
console.log(`RPC : ${JSON.stringify(byOutcome)} · budget historique restant ${wallets.budget.remaining}`);
console.log(`\n${WALLET_DISCLAIMER}`);
