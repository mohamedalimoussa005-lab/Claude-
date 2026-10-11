/**
 * Evidence Ledger — shared types.
 *
 * The ledger keeps what DETECTIVE actually observed (X posts, DEX Screener
 * snapshots, Helius / Solana RPC reads), with its anchor (signature, slot,
 * address, URL), the time of observation, its limits and what is missing.
 *
 * Nothing in this module reads a network, a clock or an environment variable,
 * and nothing here changes the Opportunity / Risk / Quality / Confidence scores.
 */

/**
 * How well an observation is established. Order = strength of the claim.
 *   FACT        directly read from a source, anchored (signature, slot, account address, URL).
 *   INDICATION  derived from facts by a stated rule; suggestive, not proof.
 *   HYPOTHESIS  a possible explanation of facts / indications; never proof.
 *   UNVERIFIED  could not be established with the available tools (gap or claim to check).
 */
export const EVIDENCE_STATUSES = ["FACT", "INDICATION", "HYPOTHESIS", "UNVERIFIED"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Labels used in reports (French, as in the DETECTIVE reports). */
export const STATUS_LABEL_FR: Record<EvidenceStatus, string> = {
  FACT: "FAIT VÉRIFIÉ",
  INDICATION: "INDICE",
  HYPOTHESIS: "HYPOTHÈSE",
  UNVERIFIED: "NON VÉRIFIÉ",
};

export const EVIDENCE_SOURCES = ["x", "dexscreener", "helius", "solana_rpc"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const EVIDENCE_TYPES = [
  "x_post", // a post and its metadata (content is untrusted data, never instructions)
  "dex_pair", // DEX Screener pair snapshot
  "mint_state", // mint authorities, extensions, supply
  "holder_distribution", // token accounts grouped by owner
  "pool_state", // AMM reserves / state
  "liquidity_position", // concentrated-liquidity position (range, owner)
  "transaction", // one transaction (creation, buy, sell, transfer)
  "funding_link", // wallet A funded wallet B
  "same_slot_activity", // several wallets active in the same slot
  "round_trip_volume", // buy then sell back by the same wallet
  "address_similarity", // look-alike addresses
  "identity_claim", // is the token what it claims to be
  "claim_check", // a post's claim compared with data
  "data_gap", // something that could not be obtained
  "liquidity_depth", // executable depth simulated from a pool's observed state
  "coordination_assessment", // hypothesis about coordination between wallets (never proof)
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * How an entry's content was obtained.
 *   observed   read directly from a source (the default).
 *   computed   a deterministic calculation from observed entries (`basedOn`), with an exact formula.
 *   estimated  a calculation that is known to be incomplete (unread data, unverified formula, unsupported feature).
 * A computed entry may be a FACT only when its formula is exact; an estimated entry is never a FACT.
 */
export const EVIDENCE_DERIVATIONS = ["observed", "computed", "estimated"] as const;
export type EvidenceDerivation = (typeof EVIDENCE_DERIVATIONS)[number];

export type FactValue = string | number | boolean | null;

/** One observed value. `key` names it; `value` is what was read (never a prediction). */
export interface EvidenceFact {
  key: string;
  value: FactValue;
}

export interface EvidenceInput {
  /** Token concerned (Solana mint), or null for evidence that concerns no single token. */
  mint: string | null;
  type: EvidenceType;
  source: EvidenceSource;
  status: EvidenceStatus;
  /** Defaults to "observed". */
  derivation?: EvidenceDerivation;
  /** One sentence describing the observation. */
  summary: string;
  facts: EvidenceFact[];
  /** When the observation was made (ISO 8601, UTC, "Z"). */
  observedAt: string;
  /** When the underlying event happened (block time, post time), if different. Not after observedAt. */
  eventTime?: string | null;
  signature?: string | null;
  slot?: number | null;
  /** Account addresses the observation is about (wallets, pools, mints). */
  addresses?: string[];
  /** Public URL of the observation (a post). */
  url?: string | null;
  /** Ids of the ledger entries this one is derived from. */
  basedOn?: string[];
  /** What bounds the observation (sampling, third-party aggregation, plan limits…). */
  limits?: string[];
  /** What was not available. Mandatory for UNVERIFIED. */
  missing?: string[];
}

export interface Evidence {
  /** Deterministic id derived from the content (stable across runs). */
  readonly id: string;
  readonly mint: string | null;
  readonly type: EvidenceType;
  readonly source: EvidenceSource;
  readonly status: EvidenceStatus;
  readonly derivation: EvidenceDerivation;
  readonly summary: string;
  readonly facts: readonly Readonly<EvidenceFact>[];
  readonly observedAt: string;
  readonly eventTime: string | null;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly addresses: readonly string[];
  readonly url: string | null;
  readonly basedOn: readonly string[];
  readonly limits: readonly string[];
  readonly missing: readonly string[];
}

export interface LedgerSnapshot {
  version: 1;
  evidence: Evidence[];
}
