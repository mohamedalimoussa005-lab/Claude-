import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../src/social/ledger.ts";
import { scoreEvidenceDataConfidence } from "../src/social/dataConfidence.ts";
import { SOCIAL_CONFIG } from "../src/social/config.ts";
import type { EvidenceInput } from "../src/social/types.ts";
import { buildPhasesLedger } from "./fixtures/social/ledger.ts";
import { MINT, SIG, WALLET } from "./fixtures/social/onchain.ts";

/**
 * Evidence Data Confidence: reliability of the collected evidence, never a probability of profit.
 * Scores depend on metadata only (status, source, anchor, type, time), not on fact values.
 */

const T0 = Date.parse("2026-10-09T18:40:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const min = (m: number) => T0 + m * 60_000;

const dex = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({ mint: MINT.A, type: "dex_pair", source: "dexscreener", status: "FACT", summary: "paire", facts: [{ key: "priceChangeH24", value: 12 }], observedAt: iso(T0), addresses: [MINT.A], ...over });
const tx = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({ mint: MINT.A, type: "transaction", source: "solana_rpc", status: "FACT", summary: "création", facts: [{ key: "feePayer", value: WALLET.aCreator }], observedAt: iso(T0), signature: SIG.aCreate, slot: 454855402, ...over });
const post = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({ mint: MINT.A, type: "x_post", source: "x", status: "FACT", summary: "post", facts: [{ key: "likes", value: 3 }], observedAt: iso(T0), url: "https://x.com/u/status/1", ...over });
const ledgerOf = (...inputs: EvidenceInput[]) => {
  const l = new EvidenceLedger();
  for (const i of inputs) l.add(i);
  return l;
};
const score = (l: EvidenceLedger, now = T0, mint: string | null = MINT.A) => scoreEvidenceDataConfidence(l, mint, now);

test("config: component weights sum to 100 and every threshold is ordered", () => {
  const c = SOCIAL_CONFIG.dataConfidence;
  assert.equal(c.weights.completeness + c.weights.freshness + c.weights.verifiability + c.weights.sources, 100);
  assert.ok(c.levels.high > c.levels.medium);
  assert.ok(c.decay.volatile.zeroMinutes > c.decay.volatile.fullMinutes);
  assert.ok(c.decay.slow.zeroMinutes > c.decay.slow.fullMinutes);
  assert.ok(c.statusWeight.FACT > c.statusWeight.INDICATION && c.statusWeight.INDICATION > c.statusWeight.HYPOTHESIS && c.statusWeight.HYPOTHESIS > c.statusWeight.UNVERIFIED);
  assert.ok(c.caps.noOnchainFact < c.levels.medium, "a token with no on-chain fact must stay LOW");
});

test("nothing recorded about a token → UNKNOWN, never 0", () => {
  const r = score(new EvidenceLedger());
  assert.equal(r.score, null);
  assert.equal(r.level, "UNKNOWN");
  assert.ok(r.limits.some((l) => /aucune preuve/.test(l)));
  assert.equal(r.missing.length, SOCIAL_CONFIG.dataConfidence.expectedChecks.length);
});

test("gap entries alone are not evidence: still UNKNOWN, and the gap is reported", () => {
  const l = ledgerOf({ mint: MINT.A, type: "data_gap", source: "helius", status: "UNVERIFIED", summary: "financeur", facts: [], observedAt: iso(T0), missing: ["financeur du wallet"] });
  const r = score(l);
  assert.equal(r.score, null);
  assert.ok(r.missing.includes("financeur du wallet"));
});

test("score is 0–100, components never exceed their maximum, and the total is their sum when uncapped", () => {
  const { ledger } = buildPhasesLedger();
  for (const m of Object.values(MINT)) {
    const r = score(ledger, Date.parse("2026-10-09T20:30:00Z"), m);
    assert.ok(r.score !== null && r.score >= 0 && r.score <= 100);
    for (const c of r.components) assert.ok(c.points >= 0 && c.points <= c.max, `${c.key} ${c.points}/${c.max}`);
    if (!r.caps.some((c) => c.applied)) assert.ok(Math.abs(r.components.reduce((s, c) => s + c.points, 0) - r.score) < 0.11);
  }
});

test("deterministic: same ledger, same time, same config → identical result", () => {
  const { ledger } = buildPhasesLedger();
  const now = Date.parse("2026-10-09T20:30:00Z");
  assert.deepEqual(scoreEvidenceDataConfidence(ledger, MINT.F, now), scoreEvidenceDataConfidence(ledger, MINT.F, now));
});

test("NOT a profit signal: the score ignores the value of every fact", () => {
  const bullish = ledgerOf(dex({ facts: [{ key: "priceChangeH24", value: 1000 }, { key: "marketCap", value: 5_000_000 }] }), tx());
  const bearish = ledgerOf(dex({ facts: [{ key: "priceChangeH24", value: -95 }, { key: "marketCap", value: 1 }] }), tx());
  assert.deepEqual(score(bullish), score(bearish));

  // Same on the whole Phase 2–4B ledger: rewrite every numeric fact and compare all seven tokens.
  const { ledger } = buildPhasesLedger();
  const snap = JSON.parse(JSON.stringify(ledger.toJSON()));
  for (const e of snap.evidence) for (const f of e.facts) if (typeof f.value === "number") f.value = -f.value * 7 - 1;
  const mutated = EvidenceLedger.fromJSON(snap);
  const now = Date.parse("2026-10-09T20:30:00Z");
  for (const m of Object.values(MINT)) {
    const a = scoreEvidenceDataConfidence(ledger, m, now);
    const b = scoreEvidenceDataConfidence(mutated, m, now);
    assert.equal(a.score, b.score, m);
    assert.equal(a.level, b.level, m);
  }
});

test("the result exposes reliability only: no profit / probability / prediction field", () => {
  const r = score(ledgerOf(dex(), tx()));
  const keys = Object.keys(r).join(",").toLowerCase();
  assert.doesNotMatch(keys, /profit|probab|predict|return|upside|buy|sell/);
  assert.equal(r.interpretation, "reliability_of_collected_evidence_not_a_probability_of_profit");
});

test("freshness: volatile observations age, immutable ones never do", () => {
  const l = ledgerOf(dex(), tx());
  const fresh = score(l, T0 + 10 * 60_000);
  const stale = score(l, T0 + 7 * 3_600_000);
  const comp = (r: ReturnType<typeof score>) => r.components.find((c) => c.key === "freshness")!.points;
  assert.equal(comp(fresh), SOCIAL_CONFIG.dataConfidence.weights.freshness);
  assert.ok(comp(stale) < comp(fresh));
  // only a volatile entry: after 6 h its freshness is exactly 0
  assert.equal(comp(score(ledgerOf(dex()), T0 + 6 * 3_600_000)), 0);
  // only immutable entries: ageing for a year changes nothing
  const imm = ledgerOf(tx(), post());
  assert.deepEqual(score(imm, T0 + 1000).components, score(imm, T0 + 400 * 86_400_000).components);
});

test("freshness decays linearly and monotonically between the thresholds", () => {
  const l = ledgerOf(dex());
  const points = [0, 15, 60, 120, 240, 360].map((m) => score(l, min(m)).components.find((c) => c.key === "freshness")!.points);
  for (let i = 1; i < points.length; i++) assert.ok(points[i]! <= points[i - 1]!, `non-increasing at index ${i}`);
  assert.equal(points[0], points[1]);
  assert.equal(points[5], 0);
});

test("an observation dated after the evaluation is clamped to age 0 and reported", () => {
  const r = score(ledgerOf(dex({ observedAt: iso(T0 + 3_600_000) })), T0);
  assert.equal(r.components.find((c) => c.key === "freshness")!.points, SOCIAL_CONFIG.dataConfidence.weights.freshness);
  assert.ok(r.limits.some((l) => /datée après l'évaluation/.test(l)));
});

test("caps: no on-chain FACT keeps the score LOW; a single source caps it lower still", () => {
  const onlyX = score(ledgerOf(post()));
  assert.ok(onlyX.caps.find((c) => c.key === "single_source")!.applied);
  assert.ok(onlyX.caps.find((c) => c.key === "no_onchain_fact")!.applied);
  assert.ok(onlyX.score! <= SOCIAL_CONFIG.dataConfidence.caps.noOnchainFact);
  assert.equal(onlyX.level, "LOW");

  const xAndDex = score(ledgerOf(post(), dex()));
  assert.ok(!xAndDex.caps.find((c) => c.key === "single_source")!.applied);
  assert.ok(xAndDex.caps.find((c) => c.key === "no_onchain_fact")!.applied);
  assert.ok(xAndDex.score! <= SOCIAL_CONFIG.dataConfidence.caps.noOnchainFact);

  const withChain = score(ledgerOf(post(), dex(), tx()));
  assert.ok(!withChain.caps.some((c) => c.applied));
  assert.ok(withChain.score! > xAndDex.score!);
  assert.ok(xAndDex.limits.some((l) => /plafonné/.test(l)));
});

test("an INDICATION on-chain does not lift the no-on-chain-FACT cap", () => {
  const l = new EvidenceLedger();
  const f = l.add(post());
  l.add({ mint: MINT.A, type: "funding_link", source: "helius", status: "INDICATION", summary: "lien", facts: [{ key: "k", value: 1 }], observedAt: iso(T0), basedOn: [f.id], limits: ["indice"] });
  assert.ok(score(l).caps.find((c) => c.key === "no_onchain_fact")!.applied);
});

test("completeness counts only FACT / INDICATION, never a HYPOTHESIS or an UNVERIFIED entry", () => {
  const l = new EvidenceLedger();
  const f = l.add(post());
  l.add({ mint: MINT.A, type: "mint_state", source: "helius", status: "HYPOTHESIS", summary: "autorités probablement révoquées", facts: [{ key: "k", value: 1 }], observedAt: iso(T0), basedOn: [f.id], limits: ["supposition"] });
  l.add({ mint: MINT.A, type: "holder_distribution", source: "helius", status: "UNVERIFIED", summary: "holders", facts: [], observedAt: iso(T0), missing: ["liste"] });
  const r = score(l);
  assert.equal(r.components.find((c) => c.key === "completeness")!.points, 0);
  assert.ok(r.missing.includes("aucun FAIT ni INDICE de type mint_state"));
  assert.ok(r.missing.includes("aucun FAIT ni INDICE de type holder_distribution"));
  assert.ok(r.missing.includes("liste"));
});

test("an UNVERIFIED entry lowers verifiability but not completeness; HYPOTHESIS weighs less than INDICATION", () => {
  const base = ledgerOf(dex(), tx());
  const withGap = ledgerOf(dex(), tx(), { mint: MINT.A, type: "claim_check", source: "x", status: "UNVERIFIED", summary: "27X", facts: [], observedAt: iso(T0), missing: ["historique de prix"] });
  const v = (r: ReturnType<typeof score>) => r.components.find((c) => c.key === "verifiability")!.points;
  assert.ok(v(score(withGap)) < v(score(base)));
  assert.equal(score(withGap).components.find((c) => c.key === "completeness")!.points, score(base).components.find((c) => c.key === "completeness")!.points);

  const mk = (status: "INDICATION" | "HYPOTHESIS") => {
    const l = new EvidenceLedger();
    const f = l.add(tx());
    l.add({ mint: MINT.A, type: "funding_link", source: "helius", status, summary: "x", facts: [{ key: "k", value: 1 }], observedAt: iso(T0), basedOn: [f.id], limits: ["l"] });
    return v(score(l));
  };
  assert.ok(mk("HYPOTHESIS") < mk("INDICATION"));
});

test("two independent sources on the same fact raise the source-quality component", () => {
  const one = ledgerOf(dex(), tx());
  const two = ledgerOf(dex(), tx(), dex({ source: "helius", summary: "paire lue via Helius", facts: [{ key: "k", value: 1 }] }));
  const s = (r: ReturnType<typeof score>) => r.components.find((c) => c.key === "sources")!.points;
  assert.ok(s(score(two)) > s(score(one)));
});

test("a transaction anchor (signature / slot) counts more than a bare account address", () => {
  const anchored = ledgerOf(tx({ type: "transaction" }));
  const bare = ledgerOf(tx({ signature: null, slot: null, addresses: [WALLET.aCreator] }));
  const v = (r: ReturnType<typeof score>) => r.components.find((c) => c.key === "verifiability")!.points;
  assert.ok(v(score(anchored)) > v(score(bare)));
});

test("Phase 2–4B ledger: every investigated contract is HIGH, the tweet-only ones stay LOW", () => {
  const { ledger } = buildPhasesLedger();
  const now = Date.parse("2026-10-09T20:30:00Z");
  const r = Object.fromEntries(Object.entries(MINT).map(([k, m]) => [k, scoreEvidenceDataConfidence(ledger, m, now)]));
  for (const k of ["A", "B", "C", "F"]) assert.equal(r[k]!.level, "HIGH", `${k}: ${r[k]!.score}`);
  for (const k of ["D", "E", "G"]) {
    assert.equal(r[k]!.level, "LOW", `${k}: ${r[k]!.score}`);
    assert.ok(r[k]!.caps.find((c) => c.key === "no_onchain_fact")!.applied);
  }
  const investigated = Math.min(...["A", "B", "C", "F"].map((k) => r[k]!.score!));
  const tweetOnly = Math.max(...["D", "E", "G"].map((k) => r[k]!.score!));
  assert.ok(investigated > tweetOnly + 30);
});

test("Phase 2–4B ledger: B is less complete than A because its pool is UNVERIFIED", () => {
  const { ledger } = buildPhasesLedger();
  const now = Date.parse("2026-10-09T20:30:00Z");
  const a = scoreEvidenceDataConfidence(ledger, MINT.A, now);
  const b = scoreEvidenceDataConfidence(ledger, MINT.B, now);
  assert.equal(a.components[0]!.points, 30);
  assert.equal(b.components[0]!.points, 24);
  assert.ok(b.missing.includes("aucun FAIT ni INDICE de type pool_state"));
  assert.ok(b.missing.some((m) => /soldes des coffres du pool/.test(m)));
  assert.ok(b.score! < a.score!);
});

test("Phase 2–4B ledger: scores fall as the observations age (volatile data goes stale)", () => {
  const { ledger } = buildPhasesLedger();
  const now = Date.parse("2026-10-09T20:30:00Z");
  const next = now + 24 * 3_600_000;
  const freshness = (m: string, at: number) => scoreEvidenceDataConfidence(ledger, m, at).components.find((c) => c.key === "freshness")!.points;
  for (const m of Object.values(MINT)) {
    assert.ok(freshness(m, next) < freshness(m, now), m); // every token has a volatile DEX snapshot
    assert.ok(scoreEvidenceDataConfidence(ledger, m, next).score! <= scoreEvidenceDataConfidence(ledger, m, now).score!, m); // a cap can hold the total equal
  }
  for (const m of [MINT.A, MINT.B, MINT.C, MINT.F]) assert.ok(scoreEvidenceDataConfidence(ledger, m, next).score! < scoreEvidenceDataConfidence(ledger, m, now).score!, m);
});

test("Phase 2–4B golden values (update only when the rubric changes on purpose)", () => {
  const { ledger } = buildPhasesLedger();
  const now = Date.parse("2026-10-09T20:30:00Z");
  const s = (m: string) => scoreEvidenceDataConfidence(ledger, m, now).score;
  assert.equal(s(MINT.A), 84.8);
  assert.equal(s(MINT.F), 83.3);
  assert.equal(s(MINT.D), 40);
});
