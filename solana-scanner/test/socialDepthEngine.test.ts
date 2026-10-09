import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger, LedgerError } from "../src/social/ledger.ts";
import { scoreEvidenceDataConfidence } from "../src/social/dataConfidence.ts";
import { analyzeDepth, DEFAULT_TARGETS, searchDepth } from "../src/social/depth/engine.ts";
import type { DepthReport } from "../src/social/depth/engine.ts";
import { recordDepthEvidence } from "../src/social/depth/evidence.ts";
import { extractLiquidityFeatures, extrasFromBuilt, LIQUIDITY_RISK_DRAFT, scoreLiquidityRiskDraft } from "../src/social/depth/liquidityRisk.ts";
import type { LiquidityFeatures } from "../src/social/depth/liquidityRisk.ts";
import { buildClmmVenue } from "../src/social/depth/snapshot.ts";
import type { BuiltVenue } from "../src/social/depth/snapshot.ts";
import { ACCOUNTS, CAPTURED_AT, DEX_PRICES, EPOCH, F_TICK_ARRAYS, MINTS, POOLS, SNAPSHOT_SLOT } from "./fixtures/social/depth/raw.ts";
import { accounts, bytesOf, venueB, venueF, venuePump } from "./helpers/depth.ts";

/** Depth engine end to end on the four real pools, evidence recording, and the draft liquidity-risk score. */

const solUsd = (k: "A" | "C") => Number(DEX_PRICES[k]!.priceUsd) / Number(DEX_PRICES[k]!.priceNative);
const QUOTE_USD = { F: { usdPerQuote: 1, source: "USDC assumed = 1 USD" }, B: { usdPerQuote: Number(DEX_PRICES["ANTHROPIC"]!.priceUsd), source: "DEX Screener ANTHROPIC priceUsd" }, A: { usdPerQuote: solUsd("A"), source: "DEX Screener priceUsd / priceNative" }, C: { usdPerQuote: solUsd("C"), source: "DEX Screener priceUsd / priceNative" } };
const pools = () => ({ F: venueF(), B: venueB(), A: venuePump("A"), C: venuePump("C") });
const reportOf = (b: BuiltVenue, k: keyof typeof QUOTE_USD): DepthReport => analyzeDepth({ venue: b.venue, quote: QUOTE_USD[k], baseSupply: b.baseSupply });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

// ───────── depth search ─────────
test("searchDepth returns the SMALLEST input reaching the impact (one unit less does not), on all four real pools", () => {
  const p = pools();
  for (const [name, b] of Object.entries(p)) {
    for (const side of ["buy", "sell"] as const) {
      for (const bps of DEFAULT_TARGETS.impactsBps) {
        const r = searchDepth(b.venue, side, bps);
        if (!r.reached) continue;
        assert.ok(r.fill, `${name} ${side} ${bps}`);
        const spot0 = b.venue.spot();
        const after = r.fill!.next.spot();
        const factor = BigInt(10_000 + (side === "buy" ? bps : -bps));
        const met = (a: typeof spot0) => (side === "buy" ? a.num * spot0.den * 10_000n >= spot0.num * a.den * factor : a.num * spot0.den * 10_000n <= spot0.num * a.den * factor);
        assert.ok(met(after), `${name} ${side} ${bps}: target not met`);
        const below = side === "buy" ? b.venue.buy(r.amount - 1n) : b.venue.sell(r.amount - 1n);
        if (below.ok) assert.ok(!met(below.next.spot()), `${name} ${side} ${bps}: not minimal`);
      }
    }
  }
});

test("ask and bid depths are separate: F can be bought deeply and sold almost not at all; the others are two-sided", () => {
  const p = pools();
  const f = reportOf(p.F, "F");
  assert.ok(f.ask.every((x) => x.reached), "F: every ask impact is reachable");
  assert.ok(f.bid.every((x) => !x.reached), "F: no bid impact is reachable");
  for (const x of f.bid) {
    assert.ok(x.output && x.output.usd !== null && x.output.usd < 1, "F: the whole bid side is worth under $1");
    assert.match(x.note ?? "", /runs out of liquidity/);
  }
  for (const k of ["A", "B", "C"] as const) {
    const r = reportOf(p[k], k);
    assert.ok(r.ask.every((x) => x.reached) && r.bid.every((x) => x.reached), `${k}: both sides reachable`);
  }
});

test("depth grows with the impact on both sides, and the achieved impact equals the target", () => {
  for (const [k, b] of Object.entries(pools())) {
    const r = reportOf(b, k as keyof typeof QUOTE_USD);
    for (const side of [r.ask, r.bid]) {
      const reached = side.filter((x) => x.reached);
      for (let i = 1; i < reached.length; i++) assert.ok(BigInt(reached[i]!.input!.raw) > BigInt(reached[i - 1]!.input!.raw), `${k}: depth must grow with impact`);
      for (const x of reached) assert.ok(Math.abs(x.achievedImpactPct! - x.impactBps / 100) < 0.01, `${k}: achieved ${x.achievedImpactPct} vs target ${x.impactBps / 100}`);
    }
  }
});

test("F: the +1 % ask depth agrees with an independent closed form L·(√(1.01 P) − √P) / (1 − fee)", () => {
  const f = reportOf(venueF(), "F");
  const L = 1_000_962_964_985_175; // pool liquidity
  const sqrtP = Math.sqrt(Number(DEX_PRICES["F"]!.priceUsd)); // ≈ √0.03410
  const closed = (L * (Math.sqrt(1.01) * sqrtP - sqrtP)) / (1 - 0.0001) / 1e6; // USDC
  const ask1 = f.ask.find((x) => x.impactBps === 100)!;
  assert.ok(rel(ask1.input!.human, closed) < 2e-3, `${ask1.input!.human} vs closed form ${closed}`);
});

test("PumpSwap A: the +1 % ask depth agrees with the effective-reserve closed form, fees included (within 0.5 %)", () => {
  const a = reportOf(venuePump("A"), "A");
  const eff = 20.636879117; // SOL: vault 3.052 + virtual 17.585
  const closed = eff * (Math.sqrt(1.01) - 1) * 1.0125;
  const ask1 = a.ask.find((x) => x.impactBps === 100)!;
  assert.ok(rel(ask1.input!.human, closed) < 5e-3, `${ask1.input!.human} vs ${closed}`);
});

// ───────── orders, supply sales, round trips ─────────
test("buy orders cover 50 / 100 / 500 / 1 000 / 10 000 USD, spend exactly the amount, and cost more per token as they grow", () => {
  for (const [k, b] of Object.entries(pools())) {
    const r = reportOf(b, k as keyof typeof QUOTE_USD);
    assert.deepEqual(r.buys.map((x) => x.label), ["buy $50", "buy $100", "buy $500", "buy $1000", "buy $10000"]);
    for (const t of r.buys) {
      assert.ok(t.ok, `${k} ${t.label}: ${t.reason}`);
      assert.ok(rel(t.amountIn!.usd!, Number(t.label.slice(5))) < 1e-6, `${k} ${t.label} spends ${t.amountIn!.usd}`);
    }
    const impacts = r.buys.map((t) => t.executionImpactPct!);
    for (let i = 1; i < impacts.length; i++) assert.ok(impacts[i]! >= impacts[i - 1]! - 1e-9, `${k}: execution impact must not shrink with size`);
  }
  const f = reportOf(venueF(), "F");
  assert.ok(f.buys.every((t) => t.executionImpactPct! < 0.02), "F: even $10 000 barely moves the price");
  const b = reportOf(venueB(), "B");
  assert.ok(b.buys[4]!.executionImpactPct! > 50, "B: a $10 000 buy is far beyond its depth");
});

test("selling 1 % and 5 % of the supply: F cannot, with its capacity reported; A, B and C can, at a cost", () => {
  const p = pools();
  const f = reportOf(p.F, "F");
  assert.deepEqual(f.supplySells.map((x) => x.label), ["sell 1% of supply", "sell 5% of supply"]);
  for (const t of f.supplySells) {
    assert.ok(!t.ok && t.reason === "liquidity_exhausted");
    assert.ok(t.capacity && t.capacity.output.usd! < 1, `F capacity ${t.capacity?.output.usd}`);
  }
  assert.equal(BigInt(f.supplySells[0]!.amountIn!.raw), (venueF().baseSupply * 100n) / 10_000n);
  for (const k of ["A", "B", "C"] as const) {
    const r = reportOf(p[k], k);
    for (const t of r.supplySells) {
      assert.ok(t.ok, `${k} ${t.label}`);
      const fair = t.amountIn!.usd!; // value at the starting spot
      assert.ok(t.amountOut!.usd! < fair && t.amountOut!.usd! > 0, `${k}: proceeds must be below the spot value`);
    }
  }
});

test("round trips: buy, then sell exactly what was received (net of fees and Token-2022 taxes) into the state the buy left", () => {
  const p = pools();
  for (const [k, b] of Object.entries(p)) {
    const r = reportOf(b, k as keyof typeof QUOTE_USD);
    assert.equal(r.roundTrips.length, 5);
    for (const t of r.roundTrips) {
      assert.ok(t.ok, `${k} $${t.usd}: ${t.note}`);
      assert.ok(BigInt(t.quoteBack!.raw) < BigInt(t.quoteIn!.raw), `${k} $${t.usd}: a round trip cannot gain`);
      assert.ok(t.lossPct! > 0);
    }
    // identical to composing the two swaps by hand
    const usd = 1000;
    const raw = BigInt(Math.round((usd / QUOTE_USD[k as keyof typeof QUOTE_USD].usdPerQuote) * 10 ** b.venue.info.quoteDecimals));
    const buy = b.venue.buy(raw);
    assert.ok(buy.ok);
    if (buy.ok) {
      const sell = buy.next.sell(buy.amountOut);
      assert.ok(sell.ok);
      const rt = r.roundTrips.find((x) => x.usd === usd)!;
      if (sell.ok) assert.ok(Math.abs(Number(sell.amountOut) - Number(rt.quoteBack!.raw)) <= Number(raw) * 1e-6, `${k}: report differs from the hand-made composition`);
    }
  }
  // magnitudes follow the fee schedules and taxes of each venue
  const loss = (k: keyof typeof QUOTE_USD) => reportOf(p[k], k).roundTrips.find((x) => x.usd === 1000)!.lossPct!;
  assert.ok(loss("F") < 0.05, "F: two 0.01 % fees");
  assert.ok(loss("A") > 2.4 && loss("A") < 2.6, "A: two 1.25 % fees");
  assert.ok(loss("B") > 5.5 && loss("B") < 7, "B: fees, creator fee and four 1 % Token-2022 taxes");
});

test("quote price unknown: depths are still computed in quote units, USD fields are null, USD orders say why", () => {
  const b = venueB();
  const r = analyzeDepth({ venue: b.venue, quote: { usdPerQuote: null, source: "unavailable" }, baseSupply: b.baseSupply });
  assert.ok(r.ask[0]!.input && r.ask[0]!.input.usd === null && r.ask[0]!.input.human > 0);
  assert.ok(r.buys.every((t) => !t.ok && t.reason === "quote_price_unavailable"));
  assert.ok(r.roundTrips.every((t) => !t.ok));
  assert.equal(r.spot.usdPerBase, null);
});

test("the report is plain JSON, deterministic, complete for supported pools, and never promises execution", () => {
  for (const [k, b] of Object.entries(pools())) {
    const r = reportOf(b, k as keyof typeof QUOTE_USD);
    const json = JSON.stringify(r);
    assert.ok(json.length > 1000 && !json.includes("NaN") && !json.includes("Infinity"));
    assert.deepEqual(JSON.parse(json).ask.length, 4);
    assert.deepEqual(reportOf(b, k as keyof typeof QUOTE_USD), r, `${k}: not deterministic`);
    assert.equal(r.complete, true, k);
    assert.match(r.disclaimer, /not a quote and not a guarantee of execution/);
  }
});

test("the order of magnitude of each pool's depth, from the real snapshot (computed here, not imposed)", () => {
  const p = pools();
  const a = reportOf(p.A, "A");
  const c = reportOf(p.C, "C");
  const b = reportOf(p.B, "B");
  const f = reportOf(p.F, "F");
  const usd = (x: DepthReport, side: "ask" | "bid", bps: number) => (side === "ask" ? x.ask : x.bid).find((y) => y.impactBps === bps)!;
  assert.ok(usd(f, "ask", 100).input!.usd! > 500_000, "F ask +1 %");
  assert.ok(usd(b, "ask", 100).input!.usd! > 20 && usd(b, "ask", 100).input!.usd! < 100, "B ask +1 %");
  assert.ok(usd(a, "ask", 100).input!.usd! > 5 && usd(a, "ask", 100).input!.usd! < 30, "A ask +1 %");
  assert.ok(usd(c, "ask", 100).input!.usd! > 20 && usd(c, "ask", 100).input!.usd! < 100, "C ask +1 %");
  assert.ok(f.exitToEntryRatio1Pct! < 1e-4);
  for (const x of [a, b, c]) assert.ok(x.exitToEntryRatio1Pct! > 0.9 && x.exitToEntryRatio1Pct! < 1.05, "two-sided pools have a ratio near 1");
});

// ───────── unsupported pools are estimates ─────────
test("a pool with unsupported features is flagged incomplete in the report and recorded as an ESTIMATE", () => {
  const copy = { ...accounts };
  const bytes = bytesOf(POOLS.F).slice();
  bytes[1096 + 20] = 1;
  copy[POOLS.F] = { owner: ACCOUNTS[POOLS.F]!.owner, data: Buffer.from(bytes).toString("base64") };
  const built = buildClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.F, accounts: copy, tickArrays: Object.values(F_TICK_ARRAYS), ticksComplete: true, epoch: EPOCH });
  const report = reportOf(built, "F");
  assert.equal(report.complete, false);
  const ledger = new EvidenceLedger();
  const ids = recordDepthEvidence({ ledger, mint: MINTS.F, report, built, observedAt: CAPTURED_AT, slot: SNAPSHOT_SLOT });
  const depth = ledger.get(ids.depth)!;
  assert.equal(depth.derivation, "estimated");
  assert.equal(depth.status, "INDICATION");
  assert.ok(depth.limits.some((l) => /non simulé: dynamic fees/.test(l)));
});

test("incomplete tick data (not every tick array read) also makes the simulation an estimate", () => {
  const one = [Object.values(F_TICK_ARRAYS)[0]!];
  const built = buildClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.F, accounts, tickArrays: one, ticksComplete: false, epoch: EPOCH });
  const report = reportOf(built, "F");
  assert.equal(report.complete, false);
  assert.ok(report.ask.some((x) => !x.reached), "the +10 % climb needs the upper tick that was not loaded");
  assert.ok(report.ask.some((x) => /beyond_loaded_data/.test(x.note ?? "")));
});

// ───────── evidence ledger ─────────
test("ledger: observed pool state, computed depth, and the status each venue earns", () => {
  const ledger = new EvidenceLedger();
  const p = pools();
  const ids = Object.fromEntries((["F", "B", "A", "C"] as const).map((k) => [k, recordDepthEvidence({ ledger, mint: MINTS[k], report: reportOf(p[k], k), built: p[k], observedAt: CAPTURED_AT, slot: SNAPSHOT_SLOT })]));
  for (const k of ["F", "B", "A", "C"] as const) {
    const obs = ledger.get(ids[k]!.observed)!;
    const depth = ledger.get(ids[k]!.depth)!;
    assert.equal(obs.derivation, "observed");
    assert.equal(obs.status, "FACT");
    assert.equal(obs.slot, SNAPSHOT_SLOT);
    assert.equal(depth.type, "liquidity_depth");
    assert.equal(depth.derivation, "computed");
    assert.deepEqual([...depth.basedOn], [obs.id]);
    assert.ok(depth.limits.some((l) => /not a quote and not a guarantee of execution/.test(l)), "never a guarantee");
    assert.ok(depth.facts.every((f) => f.value === null || ["string", "number", "boolean"].includes(typeof f.value)));
  }
  // program source read → FACT; official SDK only (closed-source PumpSwap) → INDICATION
  assert.equal(ledger.get(ids["F"]!.depth)!.status, "FACT");
  assert.equal(ledger.get(ids["B"]!.depth)!.status, "FACT");
  assert.equal(ledger.get(ids["A"]!.depth)!.status, "INDICATION");
  assert.equal(ledger.get(ids["C"]!.depth)!.status, "INDICATION");
  assert.ok(ledger.get(ids["A"]!.depth)!.limits.some((l) => /pas public/.test(l)));
  // B's quote token has live authorities: recorded as an observed fact
  assert.ok(ids["B"]!.quoteControls);
  const controls = ledger.get(ids["B"]!.quoteControls!)!;
  assert.equal(controls.status, "FACT");
  assert.equal(controls.facts.find((x) => x.key === "permanentDelegate")!.value, "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
  assert.equal(ids["A"]!.quoteControls, null, "WSOL has no authority");
  // the ledger round-trips through JSON with the new entries
  assert.deepEqual(EvidenceLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON()))).all().map((e) => e.id), ledger.all().map((e) => e.id));
});

test("ledger rules for derivations: computed needs its inputs, estimated is never a FACT, ids of observed entries are unchanged", () => {
  const l = new EvidenceLedger();
  const base = { mint: MINTS.F, type: "liquidity_depth" as const, source: "solana_rpc" as const, summary: "s", facts: [{ key: "k", value: 1 }], observedAt: CAPTURED_AT, addresses: [POOLS.F] };
  const obs = l.add({ ...base, type: "pool_state", status: "FACT", summary: "observed" });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof LedgerError ? e.code : "other";
    }
    return "none";
  };
  assert.equal(code(() => l.add({ ...base, status: "FACT", derivation: "computed" })), "bad_derivation");
  assert.equal(code(() => l.add({ ...base, status: "FACT", derivation: "estimated", basedOn: [obs.id] })), "bad_derivation");
  assert.equal(code(() => l.add({ ...base, status: "HYPOTHESIS", derivation: "computed", basedOn: [obs.id], limits: ["l"] })), "bad_derivation");
  assert.equal(code(() => l.add({ ...base, status: "INDICATION", derivation: "estimated", limits: ["l"] })), "bad_derivation");
  const ok = l.add({ ...base, status: "FACT", derivation: "computed", basedOn: [obs.id] });
  const est = l.add({ ...base, status: "INDICATION", derivation: "estimated", basedOn: [obs.id], limits: ["incomplet"], summary: "s" });
  assert.notEqual(ok.id, est.id);
  assert.equal(l.get(obs.id)!.derivation, "observed");
  // an entry written without any derivation (as before this field existed) keeps exactly the same id
  const a = new EvidenceLedger().add({ ...base, status: "FACT", summary: "legacy" });
  const b = new EvidenceLedger().add({ ...base, status: "FACT", summary: "legacy", derivation: "observed" });
  assert.equal(a.id, b.id);
  assert.equal(a.derivation, "observed");
});

test("the Evidence Data Confidence accepts depth entries, treats them as perishable, and ignores the depth values", () => {
  const ledger = new EvidenceLedger();
  const b = venueF();
  recordDepthEvidence({ ledger, mint: MINTS.F, report: reportOf(b, "F"), built: b, observedAt: CAPTURED_AT, slot: SNAPSHOT_SLOT });
  const now = Date.parse(CAPTURED_AT);
  const fresh = scoreEvidenceDataConfidence(ledger, MINTS.F, now + 60_000);
  const stale = scoreEvidenceDataConfidence(ledger, MINTS.F, now + 24 * 3_600_000);
  assert.ok(fresh.score !== null && stale.score !== null && stale.score <= fresh.score);
  assert.equal(fresh.components.find((c) => c.key === "freshness")!.points, 20);
  assert.ok(stale.components.find((c) => c.key === "freshness")!.points < fresh.components.find((c) => c.key === "freshness")!.points, "a day-old depth reading has aged (the quote-token authority fact is slower and still fresh at 24 h)");
  assert.equal(scoreEvidenceDataConfidence(ledger, MINTS.F, now + 15 * 24 * 3_600_000).components.find((c) => c.key === "freshness")!.points, 0, "after 15 days nothing is fresh");
  // rewrite every numeric fact: the score must not move (the score never reads values)
  const snap = JSON.parse(JSON.stringify(ledger.toJSON()));
  for (const e of snap.evidence) for (const f of e.facts) if (typeof f.value === "number") f.value = f.value * -3 - 1;
  assert.equal(scoreEvidenceDataConfidence(EvidenceLedger.fromJSON(snap), MINTS.F, now + 60_000).score, fresh.score);
});

// ───────── draft liquidity risk ─────────
const clean: LiquidityFeatures = { sell5PctSupplyOk: true, sell5PctExecutionImpactPct: 1, sell5PctCapacityUsd: null, exitToEntryRatio1Pct: 1, roundTripLoss1000Pct: 0.5, transferTaxBps: 0, unpayableReserveShare: 0, quoteTokenHasControls: false, simulationComplete: true };

test("liquidity risk (draft): a clean pool scores LOW, a one-way pool HIGH, and the score is labelled draft / unvalidated", () => {
  const good = scoreLiquidityRiskDraft(clean);
  assert.equal(good.status, "draft_unvalidated");
  assert.equal(good.version, "draft-0");
  assert.equal(good.interpretation, "exit_difficulty_from_simulation_not_a_probability_of_loss");
  assert.equal(good.level, "LOW");
  assert.ok(good.score! < 5);
  const oneWay = scoreLiquidityRiskDraft({ ...clean, sell5PctSupplyOk: false, sell5PctCapacityUsd: 0.9, sell5PctExecutionImpactPct: null, exitToEntryRatio1Pct: 1e-6 });
  assert.equal(oneWay.level, "HIGH");
  assert.ok(oneWay.score! > 60);
});

test("liquidity risk (draft): weights sum to 100, each component stays within its maximum, and worse inputs never lower the score", () => {
  const w = LIQUIDITY_RISK_DRAFT.weights;
  assert.equal(w.exitFeasibility + w.asymmetry + w.roundTripCost + w.controls, 100);
  const base = scoreLiquidityRiskDraft(clean).score!;
  const worse: Partial<LiquidityFeatures>[] = [{ sell5PctExecutionImpactPct: 30 }, { exitToEntryRatio1Pct: 0.3 }, { roundTripLoss1000Pct: 10 }, { transferTaxBps: 300 }, { unpayableReserveShare: 0.8 }, { quoteTokenHasControls: true }];
  let prev = base;
  for (const w2 of worse) {
    const s = scoreLiquidityRiskDraft({ ...clean, ...w2 });
    assert.ok(s.score! > base, JSON.stringify(w2));
    for (const c of s.components) assert.ok(c.points === null || (c.points >= 0 && c.points <= c.max));
    prev = Math.max(prev, s.score!);
  }
  assert.ok(prev > base);
  const maxed = scoreLiquidityRiskDraft({ sell5PctSupplyOk: false, sell5PctExecutionImpactPct: null, sell5PctCapacityUsd: 0, exitToEntryRatio1Pct: 0, roundTripLoss1000Pct: 100, transferTaxBps: 10_000, unpayableReserveShare: 1, quoteTokenHasControls: true, simulationComplete: true });
  assert.equal(maxed.score, 100);
});

test("liquidity risk (draft): unknown inputs are reported as unknown, never counted as zero; too few → no score", () => {
  const partial = scoreLiquidityRiskDraft({ ...clean, roundTripLoss1000Pct: null, transferTaxBps: null, unpayableReserveShare: null, quoteTokenHasControls: null });
  assert.equal(partial.components.find((c) => c.key === "roundTripCost")!.points, null);
  assert.equal(partial.components.find((c) => c.key === "controls")!.points, null);
  assert.equal(partial.score, null);
  assert.equal(partial.level, "UNKNOWN");
  assert.ok(partial.missing.length === 2);
  const three = scoreLiquidityRiskDraft({ ...clean, roundTripLoss1000Pct: null });
  assert.ok(three.score !== null);
  assert.equal(scoreLiquidityRiskDraft({ ...clean, simulationComplete: false }).estimated, true);
});

test("liquidity risk (draft) on the four real pools: F is the hardest to exit; the score never reads a price move or an existing score", () => {
  const p = pools();
  const risk = Object.fromEntries((["F", "B", "A", "C"] as const).map((k) => [k, scoreLiquidityRiskDraft(extractLiquidityFeatures(reportOf(p[k], k), extrasFromBuilt(p[k])))]));
  assert.equal(risk["F"]!.level, "HIGH");
  for (const k of ["B", "A", "C"]) assert.ok(risk[k]!.score! < risk["F"]!.score!, `${k} must be easier to exit than F`);
  for (const k of ["F", "B", "A", "C"]) {
    assert.ok(risk[k]!.score! >= 0 && risk[k]!.score! <= 100);
    assert.equal(risk[k]!.estimated, false);
  }
  const fFeat = extractLiquidityFeatures(reportOf(p.F, "F"), extrasFromBuilt(p.F));
  assert.equal(fFeat.sell5PctSupplyOk, false);
  assert.ok(fFeat.sell5PctCapacityUsd! < 1);
  const aFeat = extractLiquidityFeatures(reportOf(p.A, "A"), extrasFromBuilt(p.A));
  assert.ok(aFeat.unpayableReserveShare! > 0.8, "A: most of the priced reserves cannot be paid out");
  const bFeat = extractLiquidityFeatures(reportOf(p.B, "B"), extrasFromBuilt(p.B));
  assert.equal(bFeat.transferTaxBps, 100);
  assert.equal(bFeat.quoteTokenHasControls, true);
  assert.equal(extrasFromBuilt(p.A).quoteTokenHasControls, false);
});
