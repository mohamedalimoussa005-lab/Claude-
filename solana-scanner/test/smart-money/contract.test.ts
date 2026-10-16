import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEvent, eventIdOf, validateEvent } from "../../src/smart-money/contract/events.ts";
import { EVENT_KINDS, SCHEMA_VERSION } from "../../src/smart-money/contract/types.ts";
import type { EventEnvelope } from "../../src/smart-money/contract/types.ts";

const mk = (dedupKey = "k") =>
  createEvent({ kind: "wallet.profile_computed", wallet: "W", dedupKey, evidenceTier: "VERIFIED", criteriaVersion: "c1", simulated: true, data: { a: 1 }, now: 1000 });
const envelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ schemaVersion: SCHEMA_VERSION, ...mk(), seq: 1, source: "smart-money-tracker", notAdvice: true, ...over });

test("eventId is deterministic and depends on the fact, not on the time", () => {
  assert.equal(mk("a").eventId, mk("a").eventId);
  assert.notEqual(mk("a").eventId, mk("b").eventId);
  assert.equal(eventIdOf("k", "w", null, "x"), eventIdOf("k", "w", null, "x"));
  assert.notEqual(eventIdOf("k", "w", null, "x"), eventIdOf("k", "w", "m", "x"));
  const later = createEvent({ kind: "wallet.profile_computed", wallet: "W", dedupKey: "a", evidenceTier: "VERIFIED", criteriaVersion: "c1", simulated: true, data: {}, now: 9999 });
  assert.equal(later.eventId, mk("a").eventId);
});

test("a complete envelope validates; extra unknown fields are tolerated (additive evolution)", () => {
  assert.equal(validateEvent(envelope()).ok, true);
  assert.equal(validateEvent(envelope({ newFieldFromV1_1: { x: 1 } })).ok, true);
});

test("missing or mistyped fields are rejected with their names", () => {
  for (const [field, bad] of [["seq", 0], ["eventId", "x"], ["kind", "wallet.teleport"], ["evidenceTier", "SURE"], ["notAdvice", false], ["simulated", "yes"], ["subject", null], ["evidence", [{ signature: 1 }]], ["dataQuality", { level: "GREAT", unknowns: [] }]] as const) {
    const r = validateEvent(envelope({ [field]: bad }));
    assert.equal(r.ok, false, field);
    if (!r.ok) assert.ok(r.errors.includes(field), `${field}: ${r.errors}`);
  }
  assert.equal(validateEvent("nope").ok, false);
  assert.equal(validateEvent(envelope({ data: undefined })).ok, true); // data present as key
});

test("another major version is 'unsupported', not 'invalid'", () => {
  const r = validateEvent(envelope({ schemaVersion: "smart-money.event/2" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.unsupported, true);
  const bad = validateEvent({ schemaVersion: "other" });
  if (!bad.ok) assert.equal(bad.unsupported, false);
});

test("the published JSON schema matches the TypeScript contract", () => {
  const schema = JSON.parse(readFileSync(new URL("../../src/smart-money/contract/event.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, SCHEMA_VERSION);
  assert.deepEqual([...schema.properties.kind.enum].sort(), [...EVENT_KINDS].sort());
  const sample = envelope() as unknown as EventEnvelope;
  for (const req of schema.required) assert.ok(req in sample, `schema requires ${req}`);
  for (const key of Object.keys(sample)) assert.ok(schema.required.includes(key), `${key} is not declared required in the schema`);
});
