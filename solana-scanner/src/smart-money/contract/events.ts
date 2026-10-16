import { createHash } from "node:crypto";
import { EVENT_KINDS, SCHEMA_VERSION, SOURCE } from "./types.ts";
import type { DataQualityLevel, EventEnvelope, EventEvidence, EventKind, EvidenceTier, NewEvent } from "./types.ts";

export interface EventInput<D> {
  kind: EventKind;
  wallet?: string | null;
  mint?: string | null;
  /** Identifies the fact (e.g. a signature, or "profile@<criteria>@<lastSignature>"). Same key = same event. */
  dedupKey: string;
  evidence?: EventEvidence[];
  evidenceTier: EvidenceTier;
  quality?: { level: DataQualityLevel; unknowns?: string[] };
  criteriaVersion: string;
  simulated: boolean;
  data: D;
  now: number;
}

export function eventIdOf(kind: string, wallet: string | null, mint: string | null, dedupKey: string): string {
  const h = createHash("sha256").update(JSON.stringify([kind, wallet, mint, dedupKey])).digest("hex");
  return `sm1_${h.slice(0, 32)}`;
}

export function createEvent<D>(i: EventInput<D>): NewEvent<D> {
  const wallet = i.wallet ?? null;
  const mint = i.mint ?? null;
  return {
    eventId: eventIdOf(i.kind, wallet, mint, i.dedupKey),
    emittedAt: i.now,
    kind: i.kind,
    subject: { wallet, mint },
    evidence: i.evidence ?? [],
    evidenceTier: i.evidenceTier,
    dataQuality: { level: i.quality?.level ?? "UNKNOWN", unknowns: i.quality?.unknowns ?? [] },
    criteriaVersion: i.criteriaVersion,
    simulated: i.simulated,
    data: i.data,
  };
}

export type ValidationResult = { ok: true; event: EventEnvelope } | { ok: false; unsupported: boolean; errors: string[] };

const TIERS = new Set(["VERIFIED", "INFERRED", "HYPOTHESIS"]);
const LEVELS = new Set(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nullableStr = (x: unknown) => x === null || typeof x === "string";
const nullableNum = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));

/**
 * Reader-side check. Unknown extra fields are accepted (additive evolution).
 * A different major schema version is `unsupported`, not `invalid`.
 */
export function validateEvent(x: unknown): ValidationResult {
  if (!isObj(x)) return { ok: false, unsupported: false, errors: ["not an object"] };
  if (typeof x.schemaVersion !== "string" || !x.schemaVersion.startsWith("smart-money.event/")) return { ok: false, unsupported: false, errors: ["schemaVersion missing"] };
  if (x.schemaVersion !== SCHEMA_VERSION) return { ok: false, unsupported: true, errors: [`unsupported schemaVersion ${x.schemaVersion}`] };
  const errors: string[] = [];
  if (typeof x.eventId !== "string" || !x.eventId.startsWith("sm1_")) errors.push("eventId");
  if (!Number.isInteger(x.seq) || (x.seq as number) < 1) errors.push("seq");
  if (typeof x.emittedAt !== "number" || !Number.isFinite(x.emittedAt)) errors.push("emittedAt");
  if (x.source !== SOURCE) errors.push("source");
  if (typeof x.kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(x.kind)) errors.push("kind");
  if (!isObj(x.subject) || !nullableStr(x.subject.wallet) || !nullableStr(x.subject.mint)) errors.push("subject");
  if (!Array.isArray(x.evidence) || !x.evidence.every((e) => isObj(e) && typeof e.signature === "string" && nullableNum(e.slot) && nullableNum(e.time))) errors.push("evidence");
  if (typeof x.evidenceTier !== "string" || !TIERS.has(x.evidenceTier)) errors.push("evidenceTier");
  if (!isObj(x.dataQuality) || !LEVELS.has(x.dataQuality.level as string) || !Array.isArray(x.dataQuality.unknowns) || !x.dataQuality.unknowns.every((u) => typeof u === "string")) errors.push("dataQuality");
  if (typeof x.criteriaVersion !== "string") errors.push("criteriaVersion");
  if (x.notAdvice !== true) errors.push("notAdvice");
  if (typeof x.simulated !== "boolean") errors.push("simulated");
  if (!("data" in x)) errors.push("data");
  return errors.length ? { ok: false, unsupported: false, errors } : { ok: true, event: x as unknown as EventEnvelope };
}
