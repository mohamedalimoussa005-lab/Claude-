/**
 * Versioned contract between SMART MONEY TRACKER and the other agents
 * (CHIEF, DETECTIVE…). Transport v1: an append-only JSONL outbox that
 * consumers read with their own cursor (`seq`).
 *
 * Compatibility: inside "smart-money.event/1" fields are only added, never
 * removed or re-typed; readers ignore unknown fields and unknown `kind`s.
 * A breaking change ships as "smart-money.event/2" next to /1.
 */

export const SCHEMA_VERSION = "smart-money.event/1" as const;
export const SOURCE = "smart-money-tracker" as const;

export const EVENT_KINDS = [
  "agent.heartbeat",
  "wallet.profile_computed",
  // Reserved for later phases (declared now so readers can plan for them).
  "wallet.qualified",
  "wallet.demoted",
  "wallet.buy",
  "wallet.sell",
  "wallet.bot_flagged",
  "wallet.cluster_detected",
  "convergence",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** VERIFIED: read from transactions. INFERRED: reasoned from verified facts. HYPOTHESIS: unproven. */
export type EvidenceTier = "VERIFIED" | "INFERRED" | "HYPOTHESIS";
export type DataQualityLevel = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface EventEvidence {
  signature: string;
  slot: number | null;
  /** Block time in ms. */
  time: number | null;
}

export interface EventSubject {
  wallet: string | null;
  mint: string | null;
}

export interface EventEnvelope<D = unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Deterministic: the same fact never gets two ids (consumers deduplicate on it). */
  eventId: string;
  /** Position in the outbox, strictly increasing, assigned by the store. */
  seq: number;
  /** ms */
  emittedAt: number;
  source: typeof SOURCE;
  kind: EventKind;
  subject: EventSubject;
  evidence: EventEvidence[];
  evidenceTier: EvidenceTier;
  dataQuality: { level: DataQualityLevel; unknowns: string[] };
  criteriaVersion: string;
  /** Always true: nothing here is a recommendation. */
  notAdvice: true;
  /** True for fictional / replayed data: consumers must not act on it. */
  simulated: boolean;
  data: D;
}

/** What a producer provides; the store adds `seq`. */
export type NewEvent<D = unknown> = Omit<EventEnvelope<D>, "seq" | "schemaVersion" | "source" | "notAdvice">;
