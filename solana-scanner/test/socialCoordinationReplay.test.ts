import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { analyzeCoordination, recordCoordinationEvidence, extractCoordinationFeatures, scoreCoordinationRiskDraft, formatCoordination, withConfig, normalizeTx, FAMILIES } from "../src/social/coordination/index.ts";
import type { CoordinationResult } from "../src/social/coordination/index.ts";
import { EvidenceLedger } from "../src/social/ledger.ts";
import { TOKENS, inputOf, loadCapture } from "./fixtures/social/coordination/load.ts";
import type { TokenKey } from "./fixtures/social/coordination/load.ts";

/**
 * Replay of the four tokens studied in Phases 4–5 on real, frozen reads (public Solana RPC, 2026-10-09). No network.
 * Earlier estimates about these tokens are references to verify, not values imposed on the tests: what is asserted
 * here is (1) that the engine agrees with an independent reading of the raw transactions, (2) invariants, and
 * (3) the numbers this capture produces, frozen as a regression snapshot.
 */

const OBSERVED_AT = "2026-10-09T23:00:00Z";
const have = (k: TokenKey) => existsSync(new URL(`./fixtures/social/coordination/${k}.json.gz`, import.meta.url));
const results = new Map<TokenKey, CoordinationResult>();
const run = (k: TokenKey) => {
  let r = results.get(k);
  if (!r) results.set(k, (r = analyzeCoordination(inputOf(loadCapture(k)))));
  return r;
};

for (const k of TOKENS) {
  const t = (name: string, fn: () => void) => test(`replay ${k}: ${name}`, { skip: !have(k) && "fixture not captured" }, fn);

  t("the engine agrees with an independent reading of the raw transactions", () => {
    const c = loadCapture(k);
    const r = run(k);
    const raw = new Map(c.txs.map((x) => [x.transaction.signatures[0]!, x]));
    for (const s of r.swaps) {
      const x = raw.get(s.signature)!;
      assert.ok(x, "swap comes from a captured transaction");
      const signers = new Set(x.transaction.message.accountKeys.filter((a) => typeof a !== "string" && a.signer).map((a) => (a as { pubkey: string }).pubkey));
      assert.ok(signers.has(s.trader), "the trader signed the transaction");
      // token delta of the trader for the base mint, straight from pre/post token balances
      const sum = (list: typeof x.meta extends infer M ? (M extends { preTokenBalances?: infer L } ? L : never) : never) => (list ?? []).filter((b: { owner?: string; mint: string }) => b.owner === s.trader && b.mint === c.mint).reduce((a: bigint, b: { uiTokenAmount: { amount: string } }) => a + BigInt(b.uiTokenAmount.amount), 0n);
      const delta = sum(x.meta!.postTokenBalances as never) - sum(x.meta!.preTokenBalances as never);
      assert.equal(s.side === "buy" ? delta : -delta, s.baseAmount, `${s.signature}: base amount`);
      assert.ok(s.baseAmount > 0n);
      assert.ok(x.meta!.err === null);
    }
  });

  t("every captured transaction is accounted for exactly once", () => {
    const c = loadCapture(k);
    const r = run(k);
    const unique = new Set(c.txs.map((x) => x.transaction.signatures[0]!)).size;
    const skipped = Object.entries(r.skipped).filter(([n]) => n !== "no_base_delta").reduce((a, [, v]) => a + v, 0);
    assert.equal(r.swaps.length + r.transfers.length + skipped + (r.skipped.no_base_delta ?? 0), unique);
  });

  t("invariants hold and nothing states a conclusion", () => {
    const r = run(k);
    const cohort = new Set(r.launch.cohort.map((m) => m.wallet));
    assert.ok(r.launch.cohort.length <= 50 && r.funding.wallets.length <= 50);
    for (const g of r.cluster.groups) {
      assert.ok(g.wallets.every((w) => cohort.has(w)));
      assert.ok(g.families.every((f) => FAMILIES.includes(f)));
      if (g.hypothesisEligible) assert.ok(g.families.length >= 3 && g.families.some((f) => f !== "funding" && f !== "timing"));
    }
    for (const s of r.funding.shared) if (s.entity || s.probableService) assert.equal(s.discriminating, false);
    assert.ok(r.limits.some((l) => l.includes("aucune conclusion de fraude")));
    const text = formatCoordination(r);
    assert.doesNotMatch(text, /fraudeur|escroc|arnaque|manipulateur|contrôlé par|même propriétaire/i);
    assert.match(text, /Couverture:/);
  });

  t("partial history and RPC limits are declared in the result, the ledger and the draft score", () => {
    const c = loadCapture(k);
    const r = run(k);
    const ledger = new EvidenceLedger();
    recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT });
    const gaps = ledger.all().filter((e) => e.type === "data_gap");
    if (!c.coverage.signaturesComplete) {
      assert.ok(gaps.some((g) => g.summary.includes("première transaction")), "incomplete signature list is a gap");
      assert.equal(r.launch.launchObserved, false);
    }
    if (c.coverage.signaturesRead > c.coverage.transactionsRead) assert.ok(gaps.some((g) => g.summary.includes("Analyse limitée")));
    for (const g of gaps) assert.ok(g.status === "UNVERIFIED" && g.missing.length > 0);
    const wallets = Object.values(c.wallets);
    if (wallets.some((w) => !w.coverage.signaturesComplete)) assert.ok(r.limits.some((l) => l.includes("partiel")), "a partial wallet history (cohort or creator) is declared");
    const f = extractCoordinationFeatures(r);
    if (r.scopeLimited || !c.coverage.signaturesComplete) assert.equal(scoreCoordinationRiskDraft(f).partialData, true);
    assert.equal(scoreCoordinationRiskDraft(f).status, "draft_unvalidated");
  });

  t("ledger: observed → FACT, statistical → INDICATION, interpretation → HYPOTHESIS, and it round-trips", () => {
    const r = run(k);
    const ledger = new EvidenceLedger();
    const ids = recordCoordinationEvidence({ ledger, result: r, observedAt: OBSERVED_AT });
    for (const e of ledger.all()) {
      if (e.derivation === "observed" && e.type !== "data_gap") assert.equal(e.status, "FACT");
      if (e.derivation === "estimated") assert.notEqual(e.status, "FACT");
      assert.doesNotMatch(e.summary, /fraude|escroc|arnaque|rug|manipulat|contrôlé par|même propriétaire/i);
    }
    if (ids.launch) assert.equal(ledger.get(ids.launch)!.status, "INDICATION");
    if (ids.wash) assert.equal(ledger.get(ids.wash)!.status, "INDICATION");
    assert.equal(ids.hypotheses.length, r.cluster.groups.filter((g) => g.hypothesisEligible).length);
    const again = EvidenceLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
    assert.deepEqual(again.all().map((e) => e.id), ledger.all().map((e) => e.id));
  });

  t("deterministic and independent of transaction order", () => {
    const c = loadCapture(k);
    const a = run(k);
    const b = analyzeCoordination(inputOf(c, { txs: [...c.txs].reverse().map(normalizeTx) }));
    const view = (r: CoordinationResult) => JSON.stringify([r.launch.cohort.map((m) => [m.wallet, m.firstBuySlot]), r.cluster.groups.map((g) => [g.wallets, g.families]), r.funding.shared.map((s) => [s.source, s.wallets]), r.wash.roundTripShare, r.wash.permutation]);
    assert.equal(view(a), view(b));
  });

  t("configurable limits: 1 hop and 5 wallets reduce the tracing, never the cohort", () => {
    const c = loadCapture(k);
    const full = run(k);
    const small = analyzeCoordination(inputOf(c, { cfg: withConfig({ funding: { maxHops: 1, maxWallets: 5 } }) }));
    assert.deepEqual(small.launch.cohort.map((m) => m.wallet), full.launch.cohort.map((m) => m.wallet));
    assert.ok(small.funding.wallets.length <= 5);
    assert.ok(small.funding.wallets.every((w) => w.chain.length <= 1));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Regression snapshot of what THIS capture produces (public RPC reads of 2026-10-09; 250 oldest transactions of each
// mint, up to 50 launch-cohort wallets, 2 hops). They freeze today's output; they are not claims about the tokens.

const near = (a: number | null, b: number, tol: number, what: string) => assert.ok(a !== null && Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test("replay snapshot A (PumpSwap token, SOL-quoted): the whole bonding-curve phase fits in 141 slots", { skip: !have("A") && "no fixture" }, () => {
  const r = run("A");
  assert.deepEqual([r.swaps.length, r.launch.cohort.length, r.launch.launchObserved, r.quoteMint === "So11111111111111111111111111111111111111112"], [221, 50, true, true]);
  assert.equal(r.skipped.other_quote_mint, 3);
  assert.equal(r.funding.wallets.length, 50);
  assert.equal(r.funding.wallets.filter((w) => w.partial).length, 39, "39 of 50 funding histories are partial");
  assert.equal(r.funding.shared.filter((s) => s.discriminating).length, 1);
  near(r.launch.cohortSupplyShare, 0.349, 0.005, "net supply share");
  assert.ok(r.launch.cohortGrossBuyShare! > 1, "gross buys exceed the supply: wallets buy again after selling");
  assert.equal(r.launch.sync.unusual, true);
  assert.ok(r.cluster.groups.length >= 3);
  assert.equal(r.cluster.groups.filter((g) => g.hypothesisEligible).length, 0, "groups exist but none rises above what this hot launch does by chance");
  near(r.wash.roundTripShare, 0.288, 0.01, "round-trip share");
  assert.ok(r.wash.permutation!.pValue < 0.01);
  assert.equal(r.wash.transferCycles.length, 0);
});

test("replay snapshot B (Token-2022 CP-Swap token; early phase is SOL-quoted)", { skip: !have("B") && "no fixture" }, () => {
  const r = run("B");
  assert.deepEqual([r.swaps.length, r.launch.cohort.length, r.launch.launchObserved], [143, 45, true]);
  assert.equal(r.skipped.other_quote_mint, 14);
  assert.equal(r.funding.shared.length, 0);
  assert.equal(r.cluster.groups.length, 0);
  assert.equal(r.launch.sync.unusual, false);
  near(r.wash.roundTripShare, 0.137, 0.01, "round-trip share");
  assert.equal(r.wash.flags.length, 0);
  const d = scoreCoordinationRiskDraft(extractCoordinationFeatures(r));
  assert.equal(d.level, "LOW");
  assert.equal(d.partialData, true);
});

test("replay snapshot C: the launch is out of reach of free paging, and the result says so", { skip: !have("C") && "no fixture" }, () => {
  const c = loadCapture("C");
  const r = run("C");
  assert.equal(c.coverage.signaturesComplete, false);
  assert.equal(c.coverage.signaturesRead, 400_000);
  assert.equal(r.launch.launchObserved, false);
  assert.ok(r.swaps.length <= 5, "almost nothing usable in the oldest reachable transactions");
  const d = scoreCoordinationRiskDraft(extractCoordinationFeatures(r));
  assert.equal(d.score, null, "no score is invented from a cohort of one");
  assert.equal(d.level, "UNKNOWN");
  assert.ok(r.limits.some((l) => l.includes("historique incomplet")));
});

test("replay snapshot F (Raydium CLMM, USDC-quoted): 212 swaps by 5 wallets, almost all of it round trips", { skip: !have("F") && "no fixture" }, () => {
  const r = run("F");
  assert.equal(r.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.deepEqual([r.swaps.length, r.wash.distinctTraders, r.launch.cohort.length], [212, 5, 1]);
  near(r.wash.roundTripShare, 0.987, 0.005, "round-trip share");
  assert.ok(r.wash.permutation!.pValue < 0.01);
  assert.equal(r.wash.roundTripWallets.length, 2);
  assert.equal(r.cluster.groups.length, 0, "no cohort to group");
  assert.equal(r.cluster.excess, null);
  assert.equal(r.scopeLimited, true);
  const d = scoreCoordinationRiskDraft(extractCoordinationFeatures(r));
  assert.equal(d.score, null);
});

test("replay: the creator's funding is declared unestablished when the creator is a very active wallet (A, B, C), and no link is invented", () => {
  for (const k of ["A", "B", "C"] as const) {
    if (!have(k)) continue;
    const r = run(k);
    assert.equal(r.funding.creatorLinks.length, 0, k);
    assert.ok(r.funding.notes.some((n) => n.includes("historique du créateur partiel")), k);
  }
  if (have("F")) assert.ok(!run("F").funding.notes.some((n) => n.includes("historique du créateur")), "F's creator history is complete");
});
