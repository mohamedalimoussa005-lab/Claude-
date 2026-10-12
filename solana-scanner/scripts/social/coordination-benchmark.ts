/**
 * Prints the Phase 5D benchmark report (no network, fixed seeds). SYNTHETIC / semi-synthetic data only: the numbers show
 * how the procedure behaves when the truth is known by construction; they are not a real-world rate of manipulation.
 *
 *   node --experimental-strip-types --no-warnings scripts/social/coordination-benchmark.ts [launches-per-regime=200]
 */

import { community, copyTrading, marketMaking, measure, organic, planted, PLANTS, rate, seeds, semiReal } from "../../test/helpers/benchmark.ts";

const N = Number(process.argv[2] ?? 200);
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]!.toFixed(3);

console.log(`# Benchmark de coordination — ${N} lancements par régime nul, graines fixes\n`);
console.log("## Faux positifs et calibration (régimes nuls; niveau alpha=0,01 puis 0,05)");
const nulls: [string, (s: number) => ReturnType<typeof organic>][] = [
  ["organique indépendant, chaud", (s) => organic(s, { mean: 8 })],
  ["organique indépendant, étalé", (s) => organic(s, { mean: 35 })],
  ["organique corrélé (arrivée/montant/sortie), chaud", (s) => organic(s, { mean: 12, correlated: true })],
  ["organique corrélé, étalé", (s) => organic(s, { mean: 35, correlated: true })],
  ["copy-trading", (s) => copyTrading(s)],
  ["market making + arbitrage", (s) => marketMaking(s)],
  ["semi-réel A (lancement réel, financement indépendant)", (s) => semiReal("A", s, "null")],
  ["semi-réel B (lancement réel, financement indépendant)", (s) => semiReal("B", s, "null")],
];
for (const [label, make] of nulls) {
  const a = measure(seeds(N).map(make));
  const b = measure(seeds(N).map(make), { alpha: 0.05 });
  console.log(`- ${label}: faux positifs ${a.flagged}/${N} (${pct(rate(a.flagged, N))}) à 0,01 ; ${b.flagged}/${N} (${pct(rate(b.flagged, N))}) à 0,05 ; groupes décrits ${a.groupsReported} ; p min médian ${q(a.minP, 0.5)}, q05 ${q(a.minP, 0.05)} ; hypothèses ${a.hypotheses}`);
}
console.log("\n## Confondeur (association réelle financement ↔ comportement, pas une intention)");
const cm = measure(seeds(N).map((s) => community(s)));
console.log(`- communautés financées par un fondateur: signalées ${cm.flagged}/${N} (${pct(rate(cm.flagged, N))})`);

console.log("\n## Puissance de détection (coordination synthétique contrôlée, 100 lancements par case)");
for (const k of [3, 5, 8, 12]) {
  const cells = Object.entries(PLANTS).map(([name, fam]) => `${name}: ${pct(rate(measure(seeds(100).map((s) => planted(s, k, fam))).detectedPlanted, 100))}`);
  console.log(`- k=${k} wallets — ${cells.join(" | ")}`);
}
console.log("\n## Semi-réel : financement planté sur des wallets réels");
console.log(`- B, 4 wallets réels entrés au même slot: ${pct(rate(measure(seeds(100).map((s) => semiReal("B", s, "cluster", ["7unxwW", "2cPTXv", "ARnjeA", "9tiLW3"]))).detectedPlanted, 100))}`);
console.log(`- A, groupe comportemental réel de 5 wallets: ${pct(rate(measure(seeds(100).map((s) => semiReal("A", s, "cluster", ["BBQ6yY", "BtHnhj", "CWryqL", "DNio5k", "E8B7Ed"]))).detectedPlanted, 100))}`);
console.log(`- A, groupe comportemental réel de 3 wallets: ${pct(rate(measure(seeds(100).map((s) => semiReal("A", s, "cluster", ["2A9C7B", "4f5s92", "5wpwSk"]))).detectedPlanted, 100))}`);

console.log("\n## Sensibilité aux paramètres (nul corrélé étalé: faux positifs ; k=8 F+T+A+E: puissance)");
const variants: [string, Parameters<typeof measure>[1]][] = [["défaut", {}], ["alpha 0,05", { alpha: 0.05 }], ["permutations 100", { cluster: { permutations: 100 } }], ["permutations 1000", { cluster: { permutations: 1000 } }], ["tolérance de montant 2 %", { cluster: { amountTolerance: 0.02 } }], ["tolérance de montant 10 %", { cluster: { amountTolerance: 0.1 } }], ["sync 0 slot", { launch: { syncSlots: 0 } }], ["sync 3 slots", { launch: { syncSlots: 3 } }], ["sortie 1 slot", { cluster: { exitSyncSlots: 1 } }], ["sortie 5 slots", { cluster: { exitSyncSlots: 5 } }], ["3 familles par paire", { cluster: { minFamiliesForMulti: 3 } }]];
for (const [label, over] of variants) {
  const nul = measure(seeds(100).map((s) => organic(s, { mean: 35, correlated: true })), over);
  const pl = measure(seeds(100).map((s) => planted(s, 8, PLANTS["F+T+A+E"]!)), over);
  console.log(`- ${label}: faux positifs ${nul.flagged}/100 ; puissance ${pct(rate(pl.detectedPlanted, 100))}`);
}

console.log("\n## Robustesse à l'historique incomplet (fraction de wallets dont l'historique est partiel et vide)");
for (const f of [0, 0.25, 0.5, 0.75]) {
  const nul = measure(seeds(100).map((s) => organic(s, { mean: 35, correlated: true })), {}, f);
  const pl = measure(seeds(100).map((s) => planted(s, 8, PLANTS["F+T+A+E"]!)), {}, f);
  console.log(`- ${f * 100} % dégradés: inférence exécutée ${nul.inferred}/100 (nul) et ${pl.inferred}/100 (planté) ; faux positifs ${nul.flagged}/100 ; puissance ${pct(rate(pl.detectedPlanted, 100))} ; UNKNOWN ${pl.unknown}/100`);
}
console.log("\nRappel: aucune de ces valeurs n'est un taux réel de manipulation.");
