import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger, LedgerError } from "../src/social/ledger.ts";
import { formatEvidence } from "../src/social/format.ts";
import { base58Decode, isSignature, isSolanaAddress, parseIsoUtc } from "../src/social/validate.ts";
import { EVIDENCE_STATUSES, STATUS_LABEL_FR } from "../src/social/types.ts";
import type { EvidenceInput } from "../src/social/types.ts";
import { MINT, SIG, WALLET } from "./fixtures/social/onchain.ts";

/** Evidence Ledger: insertion rules, status discipline, ids, serialization. Fixtures only, no network. */

const T = "2026-10-09T18:40:00Z";
const fact = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  mint: MINT.A,
  type: "transaction",
  source: "solana_rpc",
  status: "FACT",
  summary: "Création de A",
  facts: [{ key: "feePayer", value: WALLET.aCreator }],
  observedAt: T,
  signature: SIG.aCreate,
  slot: 454855402,
  ...over,
});
const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof LedgerError && e.code === code, `expected LedgerError ${code}`);

test("a well-formed FACT is accepted, frozen and carries its anchor", () => {
  const l = new EvidenceLedger();
  const e = l.add(fact());
  assert.equal(e.status, "FACT");
  assert.equal(e.signature, SIG.aCreate);
  assert.equal(e.slot, 454855402);
  assert.ok(e.id.startsWith("ev_"));
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e.facts));
  assert.throws(() => {
    (e.facts as unknown as unknown[]).push({ key: "x", value: 1 });
  });
});

test("the four statuses exist, in French labels, and are distinct", () => {
  assert.deepEqual([...EVIDENCE_STATUSES], ["FACT", "INDICATION", "HYPOTHESIS", "UNVERIFIED"]);
  assert.deepEqual(Object.values(STATUS_LABEL_FR), ["FAIT VÉRIFIÉ", "INDICE", "HYPOTHÈSE", "NON VÉRIFIÉ"]);
});

test("FACT without any anchor (signature, slot, address, URL) is rejected", () => {
  const l = new EvidenceLedger();
  throwsCode(() => l.add(fact({ signature: null, slot: null })), "missing_anchor");
  // An account address or a URL is enough of an anchor.
  l.add(fact({ signature: null, slot: null, addresses: [WALLET.aCreator] }));
  l.add(fact({ signature: null, slot: null, summary: "post", source: "x", type: "x_post", url: "https://x.com/u/status/1" }));
});

test("FACT without any observed fact is rejected", () => {
  throwsCode(() => new EvidenceLedger().add(fact({ facts: [] })), "missing_facts");
});

test("INDICATION and HYPOTHESIS must state their limits; UNVERIFIED must say what is missing", () => {
  const l = new EvidenceLedger();
  const base = l.add(fact());
  throwsCode(() => l.add({ ...fact({ status: "INDICATION", summary: "ind", basedOn: [base.id] }), limits: [] }), "missing_limits");
  throwsCode(() => l.add({ ...fact({ status: "HYPOTHESIS", summary: "hyp", basedOn: [base.id] }), limits: [] }), "missing_limits");
  throwsCode(() => l.add({ mint: MINT.A, type: "data_gap", source: "helius", status: "UNVERIFIED", summary: "gap", facts: [], observedAt: T }), "missing_missing");
  l.add({ mint: MINT.A, type: "data_gap", source: "helius", status: "UNVERIFIED", summary: "gap", facts: [], observedAt: T, missing: ["financeur du wallet"] });
});

test("a HYPOTHESIS must name the evidence it rests on", () => {
  throwsCode(() => new EvidenceLedger().add(fact({ status: "HYPOTHESIS", summary: "h", limits: ["spéculatif"], signature: null, slot: null })), "missing_basis");
});

test("an entry cannot rest on evidence that does not exist", () => {
  throwsCode(() => new EvidenceLedger().add(fact({ status: "INDICATION", summary: "i", basedOn: ["ev_0000000000000000"], limits: ["l"] })), "unknown_basis");
});

test("no laundering: a stronger entry cannot rest on a weaker one", () => {
  const l = new EvidenceLedger();
  const f = l.add(fact());
  const ind = l.add(fact({ status: "INDICATION", summary: "ind", basedOn: [f.id], limits: ["l"] }));
  const hyp = l.add(fact({ status: "HYPOTHESIS", summary: "hyp", basedOn: [ind.id], limits: ["l"] }));
  const unv = l.add({ mint: MINT.A, type: "data_gap", source: "helius", status: "UNVERIFIED", summary: "gap", facts: [], observedAt: T, missing: ["x"] });
  // FACT only on FACT
  throwsCode(() => l.add(fact({ summary: "f2", signature: SIG.aRecipient1, basedOn: [ind.id] })), "basis_too_weak");
  // INDICATION on FACT / INDICATION only
  throwsCode(() => l.add(fact({ status: "INDICATION", summary: "i2", basedOn: [hyp.id], limits: ["l"] })), "basis_too_weak");
  throwsCode(() => l.add(fact({ status: "INDICATION", summary: "i3", basedOn: [unv.id], limits: ["l"] })), "basis_too_weak");
  // HYPOTHESIS never stacks on a HYPOTHESIS
  throwsCode(() => l.add(fact({ status: "HYPOTHESIS", summary: "h2", basedOn: [hyp.id], limits: ["l"] })), "basis_too_weak");
  // allowed: INDICATION on FACT + INDICATION
  l.add(fact({ status: "INDICATION", summary: "i4", basedOn: [f.id, ind.id], limits: ["l"] }));
});

test("the same observation cannot be added twice; a different one gets a different id", () => {
  const l = new EvidenceLedger();
  l.add(fact());
  throwsCode(() => l.add(fact()), "duplicate");
  const other = l.add(fact({ summary: "Autre création", signature: SIG.cCreate, slot: 454769379 }));
  assert.equal(l.size, 2);
  assert.ok(l.has(other.id));
});

test("ids are deterministic across ledgers and independent of insertion order", () => {
  const a = new EvidenceLedger();
  const b = new EvidenceLedger();
  const x = fact();
  const y = fact({ summary: "Création de C", mint: MINT.C, signature: SIG.cCreate, slot: 454769379 });
  const ia = [a.add(x).id, a.add(y).id];
  const ib = [b.add(y).id, b.add(x).id];
  assert.deepEqual(ia, [ib[1], ib[0]]);
});

test("format checks: mint, address, signature, slot, URL and timestamps", () => {
  const l = new EvidenceLedger();
  throwsCode(() => l.add(fact({ mint: "not-a-mint" })), "invalid_field");
  throwsCode(() => l.add(fact({ addresses: ["0OIl"] })), "invalid_field");
  throwsCode(() => l.add(fact({ signature: "abc" })), "invalid_field");
  throwsCode(() => l.add(fact({ slot: -1 })), "invalid_field");
  throwsCode(() => l.add(fact({ slot: 1.5 })), "invalid_field");
  throwsCode(() => l.add(fact({ url: "http://x.com/a" })), "invalid_field");
  throwsCode(() => l.add(fact({ observedAt: "2026-10-09T18:40:00+02:00" })), "invalid_field");
  throwsCode(() => l.add(fact({ observedAt: "2026-02-31T00:00:00Z" })), "invalid_field");
  throwsCode(() => l.add(fact({ summary: "  " })), "invalid_field");
  throwsCode(() => l.add(fact({ facts: [{ key: "k", value: Number.NaN }] })), "invalid_field");
});

test("an event cannot be dated after its observation", () => {
  const l = new EvidenceLedger();
  throwsCode(() => l.add(fact({ eventTime: "2026-10-09T19:00:00Z" })), "event_after_observation");
  l.add(fact({ eventTime: "2026-10-09T11:39:29Z" }));
});

test("snapshot round-trip keeps ids and order; tampering is detected", () => {
  const l = new EvidenceLedger();
  const f = l.add(fact());
  l.add(fact({ status: "INDICATION", summary: "ind", basedOn: [f.id], limits: ["l"] }));
  const snap = JSON.parse(JSON.stringify(l.toJSON()));
  const back = EvidenceLedger.fromJSON(snap);
  assert.deepEqual(back.all().map((e) => e.id), l.all().map((e) => e.id));
  assert.deepEqual(back.toJSON(), l.toJSON());
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.evidence[0].id = "ev_deadbeefdeadbeef";
  throwsCode(() => EvidenceLedger.fromJSON(tampered), "id_mismatch");
  const weakened = JSON.parse(JSON.stringify(snap));
  weakened.evidence[1].status = "FACT"; // an indication relabelled as a fact must not pass (the status is part of the id)
  throwsCode(() => EvidenceLedger.fromJSON(weakened), "id_mismatch");
  throwsCode(() => EvidenceLedger.fromJSON({ version: 2, evidence: [] }), "bad_snapshot");
  throwsCode(() => EvidenceLedger.fromJSON({ version: 1, evidence: [null] }), "bad_snapshot");
});

test("queries: by mint, mint list, status counts; null-mint evidence is kept", () => {
  const l = new EvidenceLedger();
  l.add(fact());
  l.add(fact({ mint: MINT.C, summary: "C", signature: SIG.cCreate, slot: 454769379 }));
  l.add({ mint: null, type: "x_post", source: "x", status: "FACT", summary: "post sans contrat", facts: [{ key: "a", value: 1 }], observedAt: T, url: "https://x.com/u/status/2" });
  assert.equal(l.forMint(MINT.A).length, 1);
  assert.deepEqual(l.mints().sort(), [MINT.A, MINT.C].sort());
  assert.deepEqual(l.countByStatus(), { FACT: 3, INDICATION: 0, HYPOTHESIS: 0, UNVERIFIED: 0 });
  assert.deepEqual(l.countByStatus(MINT.A), { FACT: 1, INDICATION: 0, HYPOTHESIS: 0, UNVERIFIED: 0 });
});

test("formatEvidence shows the French status label, anchor, limits and what is missing", () => {
  const l = new EvidenceLedger();
  const u = l.add({ mint: MINT.F, type: "identity_claim", source: "helius", status: "UNVERIFIED", summary: "Identité officielle", facts: [], observedAt: T, missing: ["adresse officielle"], limits: ["source indisponible"] });
  const text = formatEvidence(u);
  assert.match(text, /^\[NON VÉRIFIÉ\] Identité officielle/);
  assert.match(text, /manquant: adresse officielle/);
  assert.match(text, /limites: source indisponible/);
  assert.match(formatEvidence(l.add(fact())), /^\[FAIT VÉRIFIÉ\] .*\n.*sig 59spnG8H.*slot 454855402/);
});

test("validators: base58, addresses, signatures, timestamps", () => {
  assert.equal(base58Decode("0"), null);
  assert.equal(base58Decode("")?.length, undefined);
  assert.ok(isSolanaAddress("11111111111111111111111111111111")); // system program: 32 zero bytes
  assert.ok(isSolanaAddress(MINT.F));
  assert.ok(!isSolanaAddress(`${MINT.F}0`)); // "0" is not in the base58 alphabet
  assert.ok(!isSolanaAddress(MINT.F.slice(0, 20))); // too short
  assert.ok(!isSolanaAddress("l".repeat(44)));
  assert.ok(isSignature(SIG.cCreate));
  assert.ok(!isSignature(MINT.A));
  assert.equal(parseIsoUtc("2026-10-09T11:39:29Z"), Date.UTC(2026, 9, 9, 11, 39, 29));
  assert.equal(parseIsoUtc("2026-10-09T11:39:29.250Z"), Date.UTC(2026, 9, 9, 11, 39, 29, 250));
  assert.equal(parseIsoUtc("2026-10-09"), null);
  assert.equal(parseIsoUtc("2026-13-01T00:00:00Z"), null);
});
