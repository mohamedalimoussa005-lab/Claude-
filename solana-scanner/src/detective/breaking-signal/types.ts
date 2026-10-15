/**
 * Breaking Signal (phase 0, free): a post by a watched official account → extraction → verification → immediate alert →
 * DETECTIVE enquiry → second alert. Nothing here trades or recommends; a mention is not an investment recommendation.
 */

import type { Finding } from "../types.ts";

export type Provenance = "simulation" | "file" | "x-official" | "rss";
export type PostKind = "original" | "reply" | "quote" | "repost";

export interface PostEvent {
  /** Post id (X snowflake id for real posts). */
  id: string;
  authorId: string;
  /** Handle at the time of the post (can change; the numeric id is what is trusted). */
  handle: string;
  text: string;
  /** When the post was published (ms). */
  createdAt: number;
  url: string;
  kind: PostKind;
  /** Where the event came from. "x-official" only when a configured official connection delivered it. */
  provenance: Provenance;
  /** Optional: URLs found in the post (expanded). */
  links?: string[];
}

export interface WatchedAccount {
  /** Numeric X user id — the identity. Handles are display only. */
  userId: string;
  handle: string;
  label: string;
  /** Domains whose pages may be read to find a contract address announced by this account. */
  officialDomains: string[];
}

export type Level = "CONFIRMÉ" | "PROBABLE" | "NON VÉRIFIÉ";

export interface Criterion {
  id: string;
  ok: boolean | null; // null = unknown
  text: string;
}

export interface Extraction {
  addresses: string[];
  tickers: string[];
  entities: string[];
  urls: string[];
  mentionsLaunch: boolean;
}

export interface OnchainQuick {
  mint: string;
  state: "valid_mint" | "not_a_mint" | "not_found" | "unknown";
  program: string | null;
  supply: string | null;
  decimals: number | null;
  mintAuthority: string | null | "UNKNOWN";
  freezeAuthority: string | null | "UNKNOWN";
  pools: { dexId: string | null; pairAddress: string; liquidityUsd: number | null; url: string | null; createdAt: number | null }[];
  reason: string | null;
}

export interface Verification {
  level: Level;
  criteria: Criterion[];
  /** Contract address established by the post/official page; null when none. */
  officialAddress: string | null;
  addressSource: "post" | "official-page" | null;
  notes: string[];
}

export interface Homonym {
  mint: string;
  name: string | null;
  symbol: string | null;
  liquidityUsd: number | null;
  url: string | null;
}

export interface Alert {
  stage: 1 | 2;
  text: string;
  level: Level;
  provenance: Provenance;
}

export interface StageTimes {
  published: number;
  received: number;
  extracted?: number;
  verified?: number;
  notified1?: number;
  detectiveStarted?: number;
  detectiveDone?: number;
  notified2?: number;
}

export interface DetectiveBrief {
  mint: string;
  mode: string;
  calls: number;
  elapsedMs: number;
  limitsReached: string[];
  status: "done" | "failed" | "skipped";
  reason: string | null;
  findings: Finding[];
}

export interface LatencySummary {
  /** Source side: publication → reception. Simulated (not a real X delay) whenever provenance is not "x-official". */
  publicationToDetectionMs: number | null;
  publicationToDetectionIsSimulated: boolean;
  /** Our own processing: reception → extraction (timestamping) and reception → verified. */
  detectionProcessingMs: number | null;
  /** reception → first notification (does not include DETECTIVE). */
  firstAlertMs: number | null;
  /** DETECTIVE enquiry duration, and first alert → second alert. */
  investigationMs: number | null;
  firstToSecondAlertMs: number | null;
  note: string;
}

export interface BreakingResult {
  event: PostEvent;
  extraction: Extraction;
  verification: Verification;
  onchain: OnchainQuick | null;
  homonyms: Homonym[];
  alerts: Alert[];
  detective: DetectiveBrief | null;
  times: StageTimes;
  delays: Record<string, number | null>;
  latency: LatencySummary;
  duplicate: boolean;
}

export const NOT_ADVICE = "Cette alerte signale une publication; ce n'est ni une recommandation d'investissement ni une garantie. Aucun ordre n'est passé.";
