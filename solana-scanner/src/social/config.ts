/**
 * Evidence Ledger — every weight and threshold of the Evidence Data Confidence score.
 * The score is a pure function of (ledger, now, this config): same inputs → same score.
 *
 * It measures how reliable the COLLECTED EVIDENCE is. It is not a probability of
 * profit, not a price signal and not a risk score; it never reads a fact's value.
 */

import type { EvidenceSource, EvidenceStatus, EvidenceType } from "./types.ts";

/** How fast an observation of this type goes stale. */
export type Volatility = "immutable" | "slow" | "volatile";

export interface SocialConfig {
  dataConfidence: {
    /** Points per component; they sum to 100. */
    weights: { completeness: number; freshness: number; verifiability: number; sources: number };
    /** Weight of a status in the verifiability component. */
    statusWeight: Record<EvidenceStatus, number>;
    /** Verifiability multiplier by anchor: transaction (signature / slot), account or URL, or none. */
    anchorFactor: { transaction: number; account: number; none: number };
    /** How much a source's data can be trusted as a raw reading. */
    sourceReliability: Record<EvidenceSource, number>;
    /** Share of the sources component given to the mean reliability; the rest rewards corroboration. */
    reliabilityShare: number;
    /** Evidence types a token needs for a complete picture (each needs a FACT or an INDICATION). */
    expectedChecks: EvidenceType[];
    volatility: Record<EvidenceType, Volatility>;
    /** Minutes: freshness is 1 up to `fullMinutes`, then falls linearly to 0 at `zeroMinutes`. */
    decay: { slow: { fullMinutes: number; zeroMinutes: number }; volatile: { fullMinutes: number; zeroMinutes: number } };
    /** Upper bounds on the final score. */
    caps: { noOnchainFact: number; singleSource: number };
    levels: { high: number; medium: number };
  };
}

export const SOCIAL_CONFIG: SocialConfig = {
  dataConfidence: {
    weights: { completeness: 30, freshness: 20, verifiability: 30, sources: 20 },
    statusWeight: { FACT: 1, INDICATION: 0.6, HYPOTHESIS: 0.2, UNVERIFIED: 0 },
    anchorFactor: { transaction: 1, account: 0.85, none: 0.5 },
    sourceReliability: { solana_rpc: 1, helius: 0.95, dexscreener: 0.7, x: 0.4, news: 0.5 },
    reliabilityShare: 0.8,
    expectedChecks: ["mint_state", "holder_distribution", "pool_state", "dex_pair", "transaction"],
    volatility: {
      x_post: "immutable",
      transaction: "immutable",
      funding_link: "immutable",
      same_slot_activity: "immutable",
      address_similarity: "immutable",
      mint_state: "slow",
      liquidity_position: "slow",
      identity_claim: "slow",
      claim_check: "slow",
      dex_pair: "volatile",
      pool_state: "volatile",
      holder_distribution: "volatile",
      round_trip_volume: "volatile",
      data_gap: "immutable",
      liquidity_depth: "volatile",
      coordination_assessment: "slow",
    },
    decay: { slow: { fullMinutes: 24 * 60, zeroMinutes: 14 * 24 * 60 }, volatile: { fullMinutes: 15, zeroMinutes: 6 * 60 } },
    caps: { noOnchainFact: 40, singleSource: 50 },
    levels: { high: 70, medium: 45 },
  },
};
