import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCoordination, recordCoordinationEvidence, normalizeTx } from "../src/social/coordination/index.ts";
import { EvidenceLedger } from "../src/social/ledger.ts";
import { BASE_SLOT, MINT, SOL, addr, cov, mapProvider, organicLaunch, prng, swapTx, sig } from "./helpers/coordination.ts";

const CREATOR = addr("creator-wallet");
const CREATOR_FUNDER = addr("creator-funder");
type Hist = Record<string, { from: string; lamports: bigint; slot: number; n: number }[] | null>;

function market(opts: { fundedByCreator: number; fundedByCreatorFunder?: number; creatorFundedBy?: string }) {
  const raws = [];
  const map: Hist = {};
  let n = 1;
  const buyers: string[] = [];
  for (let i = 0; i < 20; i++) {
    const w = addr(`mk${i}`);
    buyers.push(w);
    raws.push(swapTx({ n: n++, slot: BASE_SLOT + 5 + i * 3, trader: w, side: "buy", base: BigInt(1e12 + i * 7e9), quote: BigInt(0.08e9 + i * 31e6) }));
    const from = i < opts.fundedByCreator ? CREATOR : i < opts.fundedByCreator + (opts.fundedByCreatorFunder ?? 0) ? CREATOR_FUNDER : addr(`own${i}`);
    map[w] = [{ from, lamports: SOL, slot: 100 + i, n: 900 + i }];
  }
  raws.push(swapTx({ n: n++, slot: BASE_SLOT, trader: CREATOR, side: "buy", base: 5n * 10n ** 12n, quote: SOL }));
  map[CREATOR] = [{ from: opts.creatorFundedBy ?? CREATOR_FUNDER, lamports: 5n * SOL, slot: 10, n: 800 }];
  map[CREATOR_FUNDER] = [];
  return { input: { mint: MINT, creator: CREATOR, supplyRaw: 10n ** 14n, txs: raws.map(normalizeTx), coverage: cov(), provider: mapProvider(map) }, buyers };
}

test("creator: wallets that received SOL from the creator or from its funder are listed with their transfer", () => {
  const m = market({ fundedByCreator: 4, fundedByCreatorFunder: 2 });
  const r = analyzeCoordination(m.input);
  assert.deepEqual(r.funding.creatorChain, [CREATOR, CREATOR_FUNDER]);
  const byKind = (k: string) => r.funding.creatorLinks.filter((l) => l.kind === k);
  assert.equal(byKind("creator").length, 4);
  assert.equal(byKind("creator_funder").length, 2);
  assert.ok(r.funding.creatorLinks.every((l) => l.firstFunding && l.lamports === SOL && l.signature && l.slot > 0));
  assert.ok(r.limits.concat(r.funding.notes).some((n) => n.includes("pas une preuve de contrôle")));
  // the creator group is a discriminating shared source flagged as creator-linked
  const s = r.funding.shared.find((x) => x.source === CREATOR)!;
  assert.deepEqual([s.wallets.length, s.creatorLinked, s.discriminating, s.entity], [4, true, true, null]);
});

test("creator: a creator-funded cohort is a funding fact only — no group, no hypothesis (giveaways and team wallets exist)", () => {
  const r = analyzeCoordination(market({ fundedByCreator: 6 }).input);
  assert.ok(r.cluster.groups.every((g) => !g.hypothesisEligible));
  const ledger = new EvidenceLedger();
  const ids = recordCoordinationEvidence({ ledger, result: r, observedAt: "2026-10-11T12:00:00Z" });
  assert.ok(ids.creatorLinks);
  const e = ledger.get(ids.creatorLinks!)!;
  assert.equal(e.status, "FACT");
  assert.ok(e.limits.some((l) => l.includes("pas une preuve de contrôle commun")));
  assert.equal(ids.hypotheses.length, 0);
  for (const x of ledger.all()) assert.doesNotMatch(x.summary, /contrôlé par|même propriétaire|fraude|arnaque/i);
});

test("creator: no link when nobody was funded by the creator, and an exchange behind the creator is not a 'creator funder'", () => {
  const cex = addr("cex-hot");
  const m = market({ fundedByCreator: 0, creatorFundedBy: cex });
  const r = analyzeCoordination({ ...m.input, entities: { [cex]: { kind: "exchange", label: "exchange X" } } });
  assert.equal(r.funding.creatorLinks.length, 0);
  assert.deepEqual(r.funding.creatorChain, [CREATOR]);
  assert.equal(r.funding.shared.length, 0);
});

test("creator: an unknown creator history does not hide direct links", () => {
  const m = market({ fundedByCreator: 3 });
  const prov = m.input.provider;
  const r = analyzeCoordination({ ...m.input, provider: (w) => (w === CREATOR ? null : prov(w)) });
  assert.equal(r.funding.creatorLinks.filter((l) => l.kind === "creator").length, 3);
  assert.deepEqual(r.funding.creatorChain, [CREATOR]);
});

test("creator: later transfers from the creator (not the first funding) are found and marked as such", () => {
  const m = market({ fundedByCreator: 0 });
  const w = m.buyers[0]!;
  const prov = m.input.provider;
  const r = analyzeCoordination({ ...m.input, provider: (x) => { const h = prov(x); return x === w && h ? { ...h, inbound: [...h.inbound, { signature: sig(5000), slot: 500, blockTime: null, from: CREATOR, to: w, lamports: SOL }] } : h; } });
  const l = r.funding.creatorLinks.find((x) => x.wallet === w)!;
  assert.deepEqual([l.kind, l.firstFunding], ["creator", false]);
});

// ---------------------------------------------------------------- copy-trading and other organic look-alikes

test("copy-trading: followers buying right after a leader with proportional round amounts form no hypothesis", () => {
  const rng = prng(33);
  const raws = [];
  const map: Hist = {};
  let n = 1;
  const leader = addr("leader");
  raws.push(swapTx({ n: n++, slot: BASE_SLOT + 20, trader: leader, side: "buy", base: 4n * 10n ** 12n, quote: 4n * SOL }));
  map[leader] = [{ from: addr("leader-src"), lamports: 10n * SOL, slot: 3, n: 700 }];
  for (let i = 0; i < 14; i++) {
    const w = addr(`follower${i}`);
    raws.push(swapTx({ n: n++, slot: BASE_SLOT + 21 + Math.floor(rng() * 3), trader: w, side: "buy", base: 10n ** 12n, quote: SOL / 2n }));
    raws.push(swapTx({ n: n++, slot: BASE_SLOT + 400 + Math.floor(rng() * 4000), trader: w, side: "sell", base: 10n ** 12n, quote: (SOL * BigInt(40 + Math.floor(rng() * 90))) / 100n }));
    map[w] = [{ from: addr(`fsrc${i}`), lamports: BigInt(Math.floor(1e9 + rng() * 5e9)), slot: 4 + i, n: 710 + i }];
  }
  const org = organicLaunch(prng(5), 20, 3000, 30);
  const input = { mint: MINT, creator: null, supplyRaw: 10n ** 14n, txs: [...raws, ...org.swaps.map((s) => swapTx({ n: Number(s.signature.length) + 20000 + org.swaps.indexOf(s), slot: s.slot, trader: s.trader, side: "buy", base: s.baseAmount, quote: s.quoteAmount }))].map(normalizeTx), coverage: cov(), provider: mapProvider({ ...map, ...Object.fromEntries(org.wallets.map((w, i) => [w, [{ from: addr(`osrc${i}`), lamports: SOL, slot: 6, n: 750 + i }]])) }) };
  const r = analyzeCoordination(input);
  assert.ok(r.launch.cohort.length >= 30);
  assert.equal(r.cluster.groups.filter((g) => g.hypothesisEligible).length, 0);
  assert.equal(r.funding.shared.filter((s) => s.discriminating).length, 0);
  assert.ok(r.wash.roundTripShare! < 0.3, "followers exit at different times: not round trips");
});

test("copy-trading bots funded by a labelled service and buying together stay non-discriminating", () => {
  const svc = addr("copytrade-service");
  const raws = [];
  const map: Hist = {};
  for (let i = 0; i < 10; i++) {
    const w = addr(`bot${i}`);
    raws.push(swapTx({ n: 1 + i, slot: BASE_SLOT + 10, trader: w, side: "buy", base: 10n ** 12n, quote: 777_000_000n }));
    map[w] = [{ from: svc, lamports: SOL, slot: 5 + i, n: 760 + i }];
  }
  const r = analyzeCoordination({ mint: MINT, creator: null, supplyRaw: 10n ** 14n, txs: raws.map(normalizeTx), coverage: cov(), provider: mapProvider(map), entities: { [svc]: { kind: "bot", label: "service de copy-trading" } } });
  assert.ok(r.funding.shared.every((s) => !s.discriminating));
  assert.ok(r.cluster.groups.every((g) => !g.families.includes("funding") && !g.hypothesisEligible));
});

test("creator: a partial or missing creator history is declared and recorded as a gap", () => {
  const m = market({ fundedByCreator: 2 });
  const prov = m.input.provider;
  const partial = analyzeCoordination({ ...m.input, provider: (w) => (w === CREATOR ? { ...prov(w)!, coverage: cov({ signaturesComplete: false }) } : prov(w)) });
  assert.ok(partial.funding.notes.some((n) => n.includes("historique du créateur partiel")));
  const missing = analyzeCoordination({ ...m.input, provider: (w) => (w === CREATOR ? null : prov(w)) });
  assert.ok(missing.funding.notes.some((n) => n.includes("historique du créateur indisponible")));
  const ledger = new EvidenceLedger();
  recordCoordinationEvidence({ ledger, result: missing, observedAt: "2026-10-11T12:00:00Z" });
  assert.ok(ledger.all().some((e) => e.type === "data_gap" && e.summary.includes("Financement du créateur non établi")));
});
