import type { WalletPnlProfile } from "./profile.ts";
import type { Round } from "./types.ts";

const sol = (x: number | null, d = 3) => (x === null ? "INCONNU" : `${x >= 0 ? "+" : ""}${x.toFixed(d)} SOL`);
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)} %`);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function formatProfile(p: WalletPnlProfile): string {
  const w = p.winRate;
  const c = p.consistency;
  const L: string[] = [];
  L.push(`Wallet ${short(p.wallet)} · historique ${p.coverage.complete ? "COMPLET" : "INCOMPLET"}`);
  if (!p.coverage.complete) L.push("⚠ PnL NON FIABLE : l'historique est tronqué ou de complétude inconnue — aucun profit n'est affirmé, seules des positions provisoires existent.");
  L.push(`Positions fermées : ${p.counts.known} connues · ${p.counts.partial} PARTIELLES · ${p.counts.provisional} provisoires · ${p.counts.unknown} INCONNUES · ${p.counts.open} ouvertes`);
  L.push(`Part du résultat connu : ${pct(p.knownShare)}`);
  L.push(`PnL réalisé (connu, frais inclus) : ${sol(p.totals.sol.realized)} sur ${p.totals.sol.rounds} position(s) SOL` + (p.totals.usd.rounds ? ` · ${p.totals.usd.realized.toFixed(2)} USD sur ${p.totals.usd.rounds} position(s) USD (non additionnés)` : ""));
  L.push(`Taux de réussite : ${w.rate === null ? "INCONNU" : `${pct(w.rate)} (${w.wins}/${w.n}, IC95 ${w.interval ? `${pct(w.interval[0])}–${pct(w.interval[1])}` : "n/a"})`} · échantillon ${w.sample === "sufficient" ? "suffisant" : `INSUFFISANT (${w.n}/${w.minRequired})`}`);
  const k = p.costs;
  L.push(`Coûts hors trading (tout le journal) : frais réseau ${k.feesSol.toFixed(6)} SOL · tips ${k.tipsSol.toFixed(6)} SOL · rent déposé ${k.rentDepositedSol.toFixed(6)} / récupéré ${k.rentRecoveredSol.toFixed(6)} SOL (immobilisé ${k.rentNetLockedSol.toFixed(6)})` + (k.uncertainRentTxs ? ` · rent NON attribuable dans ${k.uncertainRentTxs} tx` : ""));
  L.push(`  PnL de trading brut ${sol(p.totals.sol.tradingPnl)} − frais ${p.totals.sol.feesSol.toFixed(6)} − tips ${p.totals.sol.tipsSol.toFixed(6)} = ${sol(p.totals.sol.realized)} (le rent est du capital, hors résultat)`);
  if (c.n >= 2) {
    L.push(`Régularité (${c.n} positions SOL) : ROI médian ${pct(c.medianRoi)} · meilleure position = ${pct(c.bestShareOfGrossProfit)} du profit brut · PnL sans la meilleure ${sol(c.pnlWithoutBestSol)}`);
    L.push(`  drawdown max ${c.maxDrawdownSol.toFixed(3)} SOL · pire série de pertes ${c.longestLossStreak} · semaines rentables ${c.profitableWeeks}/${c.activeWeeks} · détention médiane ${c.medianHoldSeconds === null ? "n/a" : `${Math.round(c.medianHoldSeconds / 60)} min`}`);
  } else L.push("Régularité : INCONNUE (moins de 2 positions connues en SOL)");
  if (Object.keys(p.unknownReasons).length) L.push(`Causes d'inconnu : ${Object.entries(p.unknownReasons).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  for (const o of p.open) L.push(`  ouverte ${short(o.mint)} : ${o.amount} · coût connu ${o.knownCost === null ? "INCONNU" : o.knownCost.toFixed(3)}${o.hasUnknownLots ? " (+ lots au coût INCONNU)" : ""} · latent ${o.unrealized ? sol(o.unrealized.value) : "INCONNU"}`);
  if (p.failedFeeSol > 0) L.push(`Frais perdus en transactions échouées : ${p.failedFeeSol.toFixed(6)} SOL (hors PnL des positions)`);
  for (const c2 of p.caveats) L.push(`! ${c2}`);
  L.push("Données analytiques, pas un conseil financier.");
  return L.join("\n");
}

export function formatRounds(rounds: Round[]): string {
  return rounds.map((r) => `${new Date(r.closedAt).toISOString().slice(0, 16)} ${short(r.mint)} ${r.status.padEnd(11)} ${r.pnl === null ? "INCONNU".padStart(12) : (r.quote === "USD" ? `${r.pnl.toFixed(2)} USD` : sol(r.pnl)).padStart(12)} ${r.unknownReasons.join(",")}`).join("\n");
}
