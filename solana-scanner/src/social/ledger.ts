/**
 * Evidence Ledger: an append-only, validated record of what was observed.
 *
 * Rules enforced at insertion (each one is covered by a test):
 *  - FACT needs an anchor (signature, slot, account address or URL) and at least one fact.
 *  - INDICATION and HYPOTHESIS must state their limits; both must be derived (`basedOn`) or anchored.
 *  - UNVERIFIED must say what is missing.
 *  - No laundering: a FACT may rest only on FACTs, an INDICATION on FACTs / INDICATIONs, a
 *    HYPOTHESIS on FACTs / INDICATIONs. A hypothesis can never support a stronger entry.
 *  - Ids are derived from the content; the same observation cannot be added twice.
 *  - An event cannot be dated after its observation.
 */

import type { Evidence, EvidenceFact, EvidenceInput, EvidenceStatus, LedgerSnapshot } from "./types.ts";
import { EVIDENCE_SOURCES, EVIDENCE_STATUSES, EVIDENCE_TYPES } from "./types.ts";
import { isSignature, isSolanaAddress, parseIsoUtc } from "./validate.ts";

export type LedgerErrorCode =
  | "invalid_field"
  | "missing_anchor"
  | "missing_facts"
  | "missing_limits"
  | "missing_missing"
  | "missing_basis"
  | "unknown_basis"
  | "basis_too_weak"
  | "duplicate"
  | "event_after_observation"
  | "id_mismatch"
  | "bad_snapshot";

export class LedgerError extends Error {
  code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** Which statuses an entry of a given status may be derived from. */
const ALLOWED_BASIS: Record<EvidenceStatus, readonly EvidenceStatus[]> = {
  FACT: ["FACT"],
  INDICATION: ["FACT", "INDICATION"],
  HYPOTHESIS: ["FACT", "INDICATION"],
  UNVERIFIED: ["FACT", "INDICATION", "HYPOTHESIS", "UNVERIFIED"],
};

/** FNV-1a 64-bit, hex. Deterministic content id (not a security hash). */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= BigInt(byte);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function fail(code: LedgerErrorCode, message: string): never {
  throw new LedgerError(code, message);
}

function nonEmpty(s: unknown, name: string): string {
  if (typeof s !== "string" || s.trim() === "") fail("invalid_field", `${name} must be a non-empty string`);
  return s;
}

function strings(a: unknown, name: string): string[] {
  if (a === undefined) return [];
  if (!Array.isArray(a) || a.some((x) => typeof x !== "string" || x.trim() === "")) fail("invalid_field", `${name} must be an array of non-empty strings`);
  return [...(a as string[])];
}

/** Content id: same observation, same status and same basis → same id. */
export function evidenceId(e: {
  mint: string | null;
  type: string;
  source: string;
  status: string;
  basedOn: readonly string[];
  signature: string | null;
  slot: number | null;
  url: string | null;
  addresses: readonly string[];
  summary: string;
}): string {
  // The status and the basis are part of the identity: relabelling an INDICATION as a FACT changes the id.
  const key = [e.mint ?? "", e.type, e.source, e.status, [...e.basedOn].sort().join(","), e.signature ?? "", e.slot ?? "", e.url ?? "", [...e.addresses].sort().join(","), e.summary].join("\u001f");
  return `ev_${fnv1a64(key)}`;
}

/** Validates the shape of one input and returns the frozen entry. Does not look at other entries. */
export function buildEvidence(input: EvidenceInput): Evidence {
  if (!(EVIDENCE_STATUSES as readonly string[]).includes(input.status)) fail("invalid_field", `unknown status ${String(input.status)}`);
  if (!(EVIDENCE_TYPES as readonly string[]).includes(input.type)) fail("invalid_field", `unknown type ${String(input.type)}`);
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.source)) fail("invalid_field", `unknown source ${String(input.source)}`);

  const summary = nonEmpty(input.summary, "summary");
  const mint = input.mint ?? null;
  if (mint !== null && !isSolanaAddress(mint)) fail("invalid_field", `mint is not a Solana address: ${String(mint)}`);

  const observedMs = parseIsoUtc(input.observedAt);
  if (observedMs === null) fail("invalid_field", `observedAt must be ISO 8601 UTC ("...Z"): ${String(input.observedAt)}`);
  const eventTime = input.eventTime ?? null;
  if (eventTime !== null) {
    const eventMs = parseIsoUtc(eventTime);
    if (eventMs === null) fail("invalid_field", `eventTime must be ISO 8601 UTC ("...Z"): ${String(eventTime)}`);
    if (eventMs > observedMs) fail("event_after_observation", `eventTime ${eventTime} is after observedAt ${input.observedAt}`);
  }

  const signature = input.signature ?? null;
  if (signature !== null && !isSignature(signature)) fail("invalid_field", `signature is not a valid transaction signature: ${String(signature)}`);
  const slot = input.slot ?? null;
  if (slot !== null && (!Number.isSafeInteger(slot) || slot < 0)) fail("invalid_field", `slot must be a non-negative integer: ${String(slot)}`);
  const addresses = strings(input.addresses, "addresses");
  for (const a of addresses) if (!isSolanaAddress(a)) fail("invalid_field", `address is not a Solana address: ${a}`);
  const url = input.url ?? null;
  if (url !== null && !/^https:\/\/\S+$/.test(url)) fail("invalid_field", `url must be an https URL: ${String(url)}`);

  if (!Array.isArray(input.facts)) fail("invalid_field", "facts must be an array");
  const facts: EvidenceFact[] = input.facts.map((f) => {
    nonEmpty(f?.key, "fact.key");
    const v = f.value;
    if (!(v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) fail("invalid_field", `fact ${f.key}: value must be a string, a finite number, a boolean or null`);
    return Object.freeze({ key: f.key, value: v });
  });

  const basedOn = strings(input.basedOn, "basedOn");
  const limits = strings(input.limits, "limits");
  const missing = strings(input.missing, "missing");
  const anchored = signature !== null || slot !== null || addresses.length > 0 || url !== null;

  switch (input.status) {
    case "FACT":
      if (!anchored) fail("missing_anchor", `FACT "${summary}" needs a signature, a slot, an address or a URL`);
      if (facts.length === 0) fail("missing_facts", `FACT "${summary}" needs at least one observed fact`);
      break;
    case "INDICATION":
      if (facts.length === 0) fail("missing_facts", `INDICATION "${summary}" needs at least one observed fact`);
      if (!anchored && basedOn.length === 0) fail("missing_basis", `INDICATION "${summary}" must be anchored or derived (basedOn)`);
      if (limits.length === 0) fail("missing_limits", `INDICATION "${summary}" must state its limits`);
      break;
    case "HYPOTHESIS":
      if (basedOn.length === 0) fail("missing_basis", `HYPOTHESIS "${summary}" must name the evidence it rests on (basedOn)`);
      if (limits.length === 0) fail("missing_limits", `HYPOTHESIS "${summary}" must state its limits`);
      break;
    case "UNVERIFIED":
      if (missing.length === 0) fail("missing_missing", `UNVERIFIED "${summary}" must say what is missing`);
      break;
  }

  const base = { mint, type: input.type, source: input.source, status: input.status, basedOn, signature, slot, url, addresses, summary };
  const id = evidenceId(base);
  return Object.freeze({
    id,
    mint,
    type: input.type,
    source: input.source,
    status: input.status,
    summary,
    facts: Object.freeze(facts),
    observedAt: input.observedAt,
    eventTime,
    signature,
    slot,
    addresses: Object.freeze(addresses),
    url,
    basedOn: Object.freeze(basedOn),
    limits: Object.freeze(limits),
    missing: Object.freeze(missing),
  });
}

export class EvidenceLedger {
  #items = new Map<string, Evidence>();

  /** Validates and appends one entry; returns it (use `.id` to reference it from later entries). */
  add(input: EvidenceInput): Evidence {
    const e = buildEvidence(input);
    if (this.#items.has(e.id)) fail("duplicate", `"${e.summary}" is already in the ledger (${e.id})`);
    const allowed = ALLOWED_BASIS[e.status];
    for (const ref of e.basedOn) {
      const basis = this.#items.get(ref);
      if (!basis) fail("unknown_basis", `${e.status} "${e.summary}" refers to unknown evidence ${ref}`);
      if (!allowed.includes(basis.status)) fail("basis_too_weak", `${e.status} "${e.summary}" cannot rest on a ${basis.status} ("${basis.summary}")`);
    }
    this.#items.set(e.id, e);
    return e;
  }

  get(id: string): Evidence | undefined {
    return this.#items.get(id);
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  get size(): number {
    return this.#items.size;
  }

  /** All entries, in insertion order. */
  all(): readonly Evidence[] {
    return [...this.#items.values()];
  }

  /** Entries about one token (mint). */
  forMint(mint: string): readonly Evidence[] {
    return this.all().filter((e) => e.mint === mint);
  }

  /** Distinct mints present in the ledger. */
  mints(): string[] {
    return [...new Set(this.all().flatMap((e) => (e.mint === null ? [] : [e.mint])))];
  }

  countByStatus(mint?: string): Record<EvidenceStatus, number> {
    const out: Record<EvidenceStatus, number> = { FACT: 0, INDICATION: 0, HYPOTHESIS: 0, UNVERIFIED: 0 };
    for (const e of mint === undefined ? this.all() : this.forMint(mint)) out[e.status]++;
    return out;
  }

  toJSON(): LedgerSnapshot {
    return { version: 1, evidence: this.all().map((e) => JSON.parse(JSON.stringify(e)) as Evidence) };
  }

  /** Rebuilds a ledger from a snapshot, re-validating every entry and checking the stored ids. */
  static fromJSON(snapshot: unknown): EvidenceLedger {
    const s = snapshot as Partial<LedgerSnapshot> | null;
    if (!s || s.version !== 1 || !Array.isArray(s.evidence)) fail("bad_snapshot", "expected { version: 1, evidence: [...] }");
    const ledger = new EvidenceLedger();
    for (const stored of s.evidence as unknown[]) {
      if (typeof stored !== "object" || stored === null) fail("bad_snapshot", "evidence entries must be objects");
      const e = ledger.add(stored as unknown as EvidenceInput);
      if (e.id !== (stored as { id?: unknown }).id) fail("id_mismatch", `stored id ${String((stored as { id?: unknown }).id)} does not match content (${e.id})`);
    }
    return ledger;
  }
}
