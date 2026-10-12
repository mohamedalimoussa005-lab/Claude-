import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { analyzeCoordination, recordCoordinationEvidence, extractCoordinationFeatures, scoreCoordinationRiskDraft, COORDINATION_RISK_DRAFT, normalizeTx, withConfig } from "../src/social/coordination/index.ts";
import type { CoordinationFeatures } from "../src/social/coordination/index.ts";
import { EvidenceLedger } from "../src/social/ledger.ts";
import { scoreEvidenceDataConfidence } from "../src/social/dataConfidence.ts";
import { BASE_SLOT, MINT, SOL, addr, cov, mapProvider, prng, solTransferTx, swapTx, tokenTransferTx, organicFunding } from "./helpers/coordination.ts";

const OBSERVED_AT = "2026-10-09T12:00:00Z";
const FUNDER = addr("scenario-funder");
const toNorm = (raws: ReturnType<typeof swapTx>[]) => raws.map(normalizeTx);

/** Raw-transaction scenario: organic buyers + a funded, synchronous, similar-size bundle that exits together. */
function scenario(opts: { bundleSize?: number; exits?: boolean; fundBundle?: boolean } = {}) {
  const bundleSize = opts.bundleSize ?? 8;
  const rng = prng(21);
  const raws: ReturnType<typeof swapTx>[] = [];
  const wallets: string[] = [];
  let n = 1;
  for (let i = 0; i < 30; i++) {
    const w = addr(`org${i}`);
    wallets.push(w);
    const q = BigInt(Math.floor(0.06e9 + rng() * 2.5e9));
    raws.push(swapTx({ n: n++, slot: BASE_SLOT + Math.floor(-Math.log(1 - rng()) * 12), trader: w, side: "buy", base: q * 1000n, quote: q, rent: 2_039_280n }));
  }
  const bundle: string[] = [];
  for (let i = 0; i < bundleSize; i++) {
    const w = addr(`bundle${i}`);
    bundle.push(w);
    const q = 770_000_000n + BigInt(i) * 1_000_000n;
    raws.push(swapTx({ n: n++, slot: BASE_SLOT + 60, trader: w, side: "buy", base: q * 1000n, quote: q, rent: 2_039_280n }));
    if (opts.exits !== false) raws.push(swapTx({ n: n++, slot: BASE_SLOT + 400 + (i % 2), trader: w, side: "sell", base: q * 1000n, quote: (q * 13n) / 10n }));
  }
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  wallets.forEach((w, i) => (map[w] = [{ from: addr(`orgf${i}`), lamports: BigInt(1e9 + i * 7e7), slot: 100 + i, n: 70_000 + i }]));
  bundle.forEach((w, i) => (map[w] = [{ from: opts.fundBundle === false ? addr(`bf${i}`) : FUNDER, lamports: 1_000_000_000n + BigInt(i) * 400_000n, slot: 500 + i, n: 71_000 + i }]));
  const input = { mint: MINT, creator: null, supplyRaw: 1_000_000_000_000n, txs: toNorm(raws), coverage: cov(), provider: mapProvider({ ...map, [FUNDER]: [] }) };
  return { input, wallets, bundle };
}

test("end to end: raw transactions → swaps → launch, funding, cluster, wash", () => {
  const { input, bundle } = scenario();
  const r = analyzeCoordination(input);
  assert.equal(r.swaps.length, 30 + 16);
  assert.equal(r.launch.cohort.length, 38);
  assert.ok(r.funding.shared.some((s) => s.source === FUNDER && s.wallets.length === 8 && s.discriminating));
  const g = r.cluster.groups.find((x) => x.strength === "multi_signal")!;
  assert.ok(bundle.every((w) => g.wallets.includes(w)));
  assert.ok(r.limits.some((l) => l.includes("aucune conclusion de fraude")));
  assert.ok(r.limits.some((l) => l.includes("pseudonymat")));
});

test("end to end: the analysis is deterministic and independent of transaction order", () => {
  const { input } = scenario();
  const a = analyzeCoordination(input);
  const b = analyzeCoordination({ ...input, txs: [...input.txs].reverse() });
  const view = (r: typeof a) => JSON.stringify([r.launch.cohort.map((m) => m.wallet), r.cluster.groups.map((g) => [g.id, g.wallets, g.families]), r.funding.shared.map((s) => [s.source, s.wallets]), r.wash.roundTripShare]);
  assert.equal(view(a), view(b));
});

test("end to end: duplicate transactions (listed by several addresses) are counted once", () => {
  const { input } = scenario();
  const doubled = analyzeCoordination({ ...input, txs: [...input.txs, ...input.txs] });
  assert.equal(doubled.swaps.length, analyzeCoordination(input).swaps.length);
});

test("end to end: token transfers between wallets are read as transfers, never as swaps", () => {
  const { input } = scenario();
  const extra = normalizeTx(tokenTransferTx({ n: 99_000, slot: BASE_SLOT + 700, from: addr("bundle0"), to: addr("bundle1"), amount: 5n }));
  const r = analyzeCoordination({ ...input, txs: [...input.txs, extra] });
  assert.equal(r.transfers.length, 1);
  assert.equal(r.swaps.length, 46);
});

test("end to end: swaps by a known bot are excluded from the cohort", () => {
  const bot = addr("public-bot");
  const { input } = scenario();
  const botTx = normalizeTx(swapTx({ n: 98_000, slot: BASE_SLOT, trader: bot, side: "buy", base: 1000n, quote: SOL }));
  const r = analyzeCoordination({ ...input, txs: [...input.txs, botTx], entities: { [bot]: { kind: "bot", label: "bot public" } } });
  assert.ok(!r.launch.cohort.some((m) => m.wallet === bot));
  assert.ok(r.launch.excluded.some((x) => x.wallet === bot));
});

// ---------------------------------------------------------------- ledger

test("priority 0: by default NO hypothesis is written, only facts, descriptive measures, indications and gaps", () => {
  const { input } = scenario();
  const r = analyzeCoordination(input);
  assert.ok(r.cluster.groups.some((g) => g.significant), "the planted bundle is statistically significant…");
  assert.ok(r.cluster.groups.every((g) => !g.hypothesisEligible), "…and still no hypothesis is eligible");
  const ledger = new EvidenceLedger();
  const ids = recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT });
  assert.equal(ids.hypotheses.length, 0);
  assert.ok(!ledger.all().some((e) => e.status === "HYPOTHESIS" || e.type === "coordination_assessment"));
  assert.ok(ledger.all().some((e) => e.limits.some((l) => l.includes("aucune hypothèse écrite: hypothèses automatiques désactivées"))));
  assert.ok(ledger.all().some((e) => e.status === "FACT") && ledger.all().some((e) => e.status === "INDICATION"));
});

test("ledger: observed facts, computed indications and the hypothesis are kept strictly apart (hypotheses explicitly enabled)", () => {
  const { input } = scenario();
  const r = analyzeCoordination({ ...input, cfg: withConfig({ hypotheses: { enabled: true } }) });
  const ledger = new EvidenceLedger();
  const ids = recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT });
  const all = ledger.all();
  const byId = new Map(all.map((e) => [e.id, e]));

  // observed = FACT; transactions and funding transfers are observed, anchored by their signature
  for (const e of all.filter((x) => x.derivation === "observed" && x.type !== "data_gap")) {
    assert.equal(e.status, "FACT");
    assert.ok(e.signature && e.slot !== null, e.summary);
  }
  assert.ok(all.some((e) => e.type === "transaction"));
  assert.ok(all.some((e) => e.type === "funding_link" && e.derivation === "observed"));

  // statistical indices are INDICATIONs, never FACTs
  const launch = byId.get(ids.launch!)!;
  assert.equal(launch.status, "INDICATION");
  assert.equal(launch.derivation, "computed");
  assert.ok(launch.limits.some((l) => l.includes("aucune p-value")));
  assert.equal(byId.get(ids.wash!)!.status, "INDICATION");
  for (const g of ids.groups) assert.equal(byId.get(g)!.status, "INDICATION");

  // the hypothesis exists, is a HYPOTHESIS, rests on an indication and names the ordinary explanations
  assert.equal(ids.hypotheses.length, 1);
  const h = byId.get(ids.hypotheses[0]!)!;
  assert.equal(h.status, "HYPOTHESIS");
  assert.equal(h.type, "coordination_assessment");
  assert.ok(h.summary.includes("non démontrée"));
  assert.ok(h.limits.join(" ").includes("explications ordinaires non exclues"));
  assert.ok(h.limits.join(" ").includes("aucune conclusion de fraude"));
  assert.equal(byId.get(h.basedOn[0]!)!.status, "INDICATION");
});

test("ledger: no summary states fraud, ownership or intent", () => {
  const { input } = scenario();
  const ledger = new EvidenceLedger();
  recordCoordinationEvidence({ ledger, result: analyzeCoordination(input), observedAt: OBSERVED_AT });
  for (const e of ledger.all()) assert.doesNotMatch(e.summary, /fraude|escroc|arnaque|rug|manipulat|contrôlé par|même propriétaire|propriétaire commun/i, e.summary);
});

test("ledger: funding + timing only → indications, but no hypothesis", () => {
  const { input } = scenario({ exits: false });
  // make the bundle's amounts differ so that only funding and timing remain
  const different = scenario({ exits: false });
  const r = analyzeCoordination(different.input);
  const g = r.cluster.groups.find((x) => x.wallets.includes(addr("bundle0")));
  assert.ok(g);
  void input;
  const ledger = new EvidenceLedger();
  const ids = recordCoordinationEvidence({ ledger, result: { ...r, cluster: { ...r.cluster, groups: r.cluster.groups.map((x) => ({ ...x, families: ["funding", "timing"], hypothesisEligible: false })) } }, observedAt: OBSERVED_AT });
  assert.equal(ids.hypotheses.length, 0);
  assert.ok(ids.groups.length > 0);
});

test("ledger: incomplete coverage becomes UNVERIFIED data_gap entries and downgrades computed to estimated", () => {
  const { input } = scenario();
  const partial = analyzeCoordination({ ...input, coverage: cov({ signaturesComplete: false, transactionsMissing: 4 }), cfg: withConfig({ funding: { maxWallets: 10 } }) });
  const ledger = new EvidenceLedger();
  const ids = recordCoordinationEvidence({ ledger, result: partial, observedAt: OBSERVED_AT });
  const gaps = ledger.all().filter((e) => e.type === "data_gap");
  assert.ok(gaps.length >= 3, "history, missing transactions and untraced wallets are all recorded");
  for (const g of gaps) {
    assert.equal(g.status, "UNVERIFIED");
    assert.ok(g.missing.length > 0);
  }
  assert.ok(gaps.some((g) => g.summary.includes("première transaction")));
  assert.ok(gaps.some((g) => g.summary.includes("plafond")));
  const launch = ledger.get(ids.launch!)!;
  assert.equal(launch.derivation, "estimated");
  assert.equal(ledger.get(ids.wash!)!.derivation, "estimated");
});

test("ledger: wallets without history and partial histories are recorded as gaps", () => {
  const { input, wallets } = scenario();
  const prov = input.provider;
  const r = analyzeCoordination({ ...input, provider: (w) => (w === wallets[0] ? null : w === wallets[1] ? { ...prov(w)!, coverage: cov({ signaturesComplete: false }) } : prov(w)) });
  const ledger = new EvidenceLedger();
  recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT });
  const text = ledger.all().filter((e) => e.type === "data_gap").map((e) => e.summary).join(" | ");
  assert.match(text, /sans historique de financement/);
  assert.match(text, /historique partiel/);
});

test("ledger: round-trips through JSON and feeds the Evidence Data Confidence without errors", () => {
  const { input } = scenario();
  const ledger = new EvidenceLedger();
  recordCoordinationEvidence({ ledger, result: analyzeCoordination(input), observedAt: OBSERVED_AT });
  const again = EvidenceLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.deepEqual(again.all().map((e) => e.id), ledger.all().map((e) => e.id));
  const score = scoreEvidenceDataConfidence(again, MINT, Date.parse("2026-10-09T12:05:00Z"));
  assert.ok(score.score !== null && score.score >= 0 && score.score <= 100);
});

test("ledger: recording twice into one ledger is rejected as a duplicate, not silently doubled", () => {
  const { input } = scenario();
  const r = analyzeCoordination(input);
  const ledger = new EvidenceLedger();
  recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT });
  assert.throws(() => recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT }), /duplicate/);
});

// ---------------------------------------------------------------- draft score

const F = (over: Partial<CoordinationFeatures> = {}): CoordinationFeatures => ({ launchObserved: true, dataComplete: true, cohortSize: 40, cohortSupplyShare: 0.05, top5BuyShare: 0.2, sharedFundingShare: 0, tracedWallets: 40, multiSignalWalletShare: 0, significantGroupWalletShare: 0, maxFamilies: 0, motifVolumeShare: 0, fundingKnownShare: 1, metronomicWallets: 0, transferCycles: 0, ...over });

test("risk draft: status, version and interpretation say what it is not", () => {
  const d = scoreCoordinationRiskDraft(F());
  assert.equal(d.status, "draft_unvalidated");
  assert.equal(d.version, "draft-0");
  assert.equal(d.interpretation, "indicators_of_coordinated_behaviour_not_intent_not_fraud");
  assert.equal(Object.values(COORDINATION_RISK_DRAFT.weights).reduce((a, b) => a + b, 0), 100);
});

test("risk draft: unknown inputs are unknown, never zero; too few components → no score", () => {
  const few = scoreCoordinationRiskDraft(F({ cohortSupplyShare: null, sharedFundingShare: null, motifVolumeShare: null }));
  assert.equal(few.score, null);
  assert.equal(few.level, "UNKNOWN");
  assert.equal(few.missing.length, 3);
  const three = scoreCoordinationRiskDraft(F({ motifVolumeShare: null }));
  assert.notEqual(three.score, null);
  assert.equal(three.components.find((c) => c.key === "volumePattern")!.points, null);
});

test("risk draft: partial data is flagged", () => {
  assert.equal(scoreCoordinationRiskDraft(F({ dataComplete: false })).partialData, true);
  assert.equal(scoreCoordinationRiskDraft(F()).partialData, false);
});

test("risk draft: a coordinated token scores above an organic one, and each indicator is monotone", () => {
  const quiet = scoreCoordinationRiskDraft(F());
  const loud = scoreCoordinationRiskDraft(F({ cohortSupplyShare: 0.4, sharedFundingShare: 0.6, multiSignalWalletShare: 0.5, significantGroupWalletShare: 0.5, maxFamilies: 4, motifVolumeShare: 0.4, metronomicWallets: 2, transferCycles: 1 }));
  assert.ok(quiet.score! < 10, `quiet ${quiet.score}`);
  assert.ok(loud.score! >= 60 && loud.level === "HIGH", `loud ${loud.score}`);
  const rng = prng(4);
  for (let i = 0; i < 100; i++) {
    const base = F({ cohortSupplyShare: rng() * 0.5, sharedFundingShare: rng() * 0.8, multiSignalWalletShare: rng() * 0.6, significantGroupWalletShare: rng() * 0.6, motifVolumeShare: rng() * 0.5 });
    const more = { ...base, sharedFundingShare: Math.min(1, base.sharedFundingShare! + 0.1) };
    assert.ok(scoreCoordinationRiskDraft(more).score! >= scoreCoordinationRiskDraft(base).score!);
  }
});

test("risk draft: features come from a result and the score stays within 0..100", () => {
  const { input } = scenario();
  const f = extractCoordinationFeatures(analyzeCoordination(input));
  assert.ok(f.multiSignalWalletShare! > 0.1);
  assert.ok(f.significantGroupWalletShare! > 0.1, "the planted bundle is a group chance rarely produces");
  assert.ok(f.sharedFundingShare! > 0.15);
  const d = scoreCoordinationRiskDraft(f);
  assert.ok(d.score! >= 0 && d.score! <= 100);
  const organic = scenario({ bundleSize: 0 });
  const o = scoreCoordinationRiskDraft(extractCoordinationFeatures(analyzeCoordination(organic.input)));
  assert.ok(o.score! < d.score!, `${o.score} < ${d.score}`);
});

test("risk draft: partial funding coverage lowers certainty without inventing a value", () => {
  const { input } = scenario();
  const r = analyzeCoordination({ ...input, provider: () => null });
  const f = extractCoordinationFeatures(r);
  assert.equal(f.sharedFundingShare, null);
  assert.equal(f.dataComplete, false);
});

// ---------------------------------------------------------------- isolation

const dir = new URL("../src/social/coordination/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

test("coordination: pure module — no network, environment, clock, randomness, file access or dynamic import", () => {
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|process\.env|Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random\s*\(|\brequire\s*\(|\bimport\s*\(|node:(fs|http|https|net|child_process)/;
  assert.ok(files.length >= 10);
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), banned, f);
});

test("coordination: imports nothing from the scoring layers and nothing outside src/social imports it", () => {
  const forbidden = /from\s+["']\.\.\/\.\.\/(scoring|final|wallets|onchain|outcomes|domain|api|history|rpc|ui)\//;
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), forbidden, f);
  for (const d of ["../src/", "../server/"]) {
    const root = new URL(d, import.meta.url);
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel) || rel.replaceAll("\\", "/").startsWith("social/") || rel.replaceAll("\\", "/").startsWith("detective/")) continue;
      assert.doesNotMatch(readFileSync(new URL(rel, root), "utf8"), /from\s+["'][^"']*\/social\//, `${d}${rel}`);
    }
  }
});

test("the existing scores are untouched by the coordination draft (no scoring file mentions it)", () => {
  for (const f of ["../src/scoring/config.ts", "../src/final/assessment.ts"]) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /coordination/i, f);
});

test("helpers: SOL transfer fixture is a valid funding transaction", () => {
  const t = normalizeTx(solTransferTx({ n: 5, slot: 5, from: addr(1), to: addr(2), lamports: SOL }));
  assert.equal(t.solTransfers.length, 1);
  assert.equal(typeof organicFunding, "function");
});
