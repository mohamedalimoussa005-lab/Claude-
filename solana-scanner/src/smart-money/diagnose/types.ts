/**
 * Offline diagnostic of an already collected wallet history (cache + saved report). Read-only, no network.
 * JSON-safe: no bigint, no secret. Every section says whether it could be computed (`status`) and, if not, why.
 */

export const DIAGNOSE_SCHEMA = "smart-money.diagnose/1" as const;

export type SectionStatus = "ok" | "partial" | "impossible";

export interface Section {
  status: SectionStatus;
  /** Why it is partial / impossible. */
  reason?: string;
}

export interface TxRef {
  signature: string;
  slot: number | null;
  time: number | null;
  date: string | null;
}

export interface SourcesInfo extends Section {
  cache: { present: boolean; readable: boolean; txsInCache: number; txsForWallet: number };
  report: { present: boolean; name: string | null; writtenAt: string | null };
  /** Names only, never content. */
  filesRead: string[];
  problems: string[];
}

export interface WindowInfo extends Section {
  txCount: number;
  withoutTime: number;
  oldest: TxRef | null;
  newest: TxRef | null;
  spanDays: number | null;
  txPerDay: number | null;
  originKnown: boolean;
  originDate: string | null;
  /** The saved report's own view, when there is one. */
  reportWindow: { oldest: string | null; newest: string | null; complete: boolean; stopReason: string } | null;
  matchesReport: boolean | null;
  /** What is NOT covered, in words. */
  absent: string[];
}

export interface ReconcileRow {
  label: string;
  value: number | null;
}

export interface Reconciliation extends Section {
  rows: ReconcileRow[];
  /** listed − retrieved */
  gap: number | null;
  explainedBy: { failed: number | null; missing: number | null };
  gapExplained: boolean | null;
  budget: { reportedCalls: number | null; expectedIfFailedNotRequested: number | null; expectedIfFailedRequested: number | null; verdict: "failed_not_requested" | "failed_requested" | "unexplained" | "not_applicable" } | null;
  failedInCache: number;
  verdict: string;
}

export interface OrphanSale extends TxRef {
  mint: string;
  tokenAmount: number;
  inventoryBefore: number;
  orphanAmount: number;
  hoursAfterWindowStart: number | null;
  /** Acquisitions of the same token in the very same slot, placed AFTER this sale by the ledger order. */
  sameSlotAcquisitionsAfter: string[];
  laterAcquisitions: number;
}

export type OrphanCategory = "pre_window" | "order_ambiguity" | "partial_inventory" | "rounding";

export interface OrphanGroup {
  mint: string;
  category: OrphanCategory;
  sales: OrphanSale[];
  totalOrphanAmount: number;
  /** Bought again after the orphan sales (a re-entry): the missing buy is older than the window. */
  reboughtLater: boolean;
}

export interface SameSlotCase {
  mint: string;
  slot: number;
  /** In the order the ledger applied them (slot, then signature: the true order inside a slot is not in the data). */
  sequence: { signature: string; what: "buy" | "sell" | "transfer_in" | "transfer_out" | "undecodable" }[];
  effect: "creates_orphan_sale" | "order_matters" | "none";
}

export interface Orphans extends Section {
  salesWithoutKnownBuy: number;
  distinctTokens: number;
  groups: OrphanGroup[];
  sameSlot: SameSlotCase[];
  /** Does this walker agree with the PnL engine? */
  engineCrossCheck: { engineTokens: number; walkerTokens: number; agree: boolean };
}

export type RentCause = "sponsored_fee_payer" | "incomplete_signers" | "co_signer" | "non_standard_rent_like_with_ata";
export type RentVerdict = "likely_false_positive_counterparty" | "likely_real_account_event" | "funding_unattributed" | "undetermined";

export interface RentAccount {
  account: string;
  lamports: number;
  role: "wallet" | "co_signer" | "fee_payer" | "standard_rent_created" | "standard_rent_closed" | "rent_like_band" | "other";
  /** The account also owns a token balance that moved: a pool / bonding curve, not a user token account. */
  isTokenOwner: boolean;
}

export interface RentCase extends TxRef {
  kind: "trade" | "transfer" | "undecodable";
  side: "buy" | "sell" | null;
  mint: string | null;
  walletLamports: number;
  feeLamports: number;
  tradingSol: number | null;
  signerCount: number;
  signersComplete: boolean;
  feePayerIsWallet: boolean;
  coSigners: { account: string; netLamports: number }[];
  ataProgramRan: boolean;
  standardCreated: number;
  standardClosed: number;
  causes: RentCause[];
  verdict: RentVerdict;
  /** The wallet moved ≤ 0.005 SOL (fee included): small enough for a pool account's SOL delta to look like a rent. */
  microTrade: boolean;
  accounts: RentAccount[];
  notes: string[];
}

export interface RentDiagnosis extends Section {
  uncertainTxs: number;
  identifiedTxs: number;
  byCause: Record<string, number>;
  byVerdict: Record<string, number>;
  microTradeCases: number;
  cases: RentCase[];
}

export interface DepthEstimate extends Section {
  holdSamples: number;
  holdHours: { p50: number | null; p75: number | null; p90: number | null };
  perGroup: { mint: string; hoursSinceWindowStart: number | null; extraHoursNeeded: number | null; verdict: "bought_inside_window_expected" | "covered_by_modest_extension" | "beyond_usual_holding_time" | "unknown" }[];
  /** Orphan tokens an extension to `targetTransactions` plausibly covers (heuristic). */
  extension: { targetTransactions: number; extraHours: number | null; plausiblyCovered: number | null; of: number };
  caveats: string[];
}

export interface DiagnosticReport {
  schema: typeof DIAGNOSE_SCHEMA;
  generatedAt: string;
  readOnly: true;
  network: false;
  wallet: string;
  sources: SourcesInfo;
  window: WindowInfo;
  reconciliation: Reconciliation;
  orphans: Orphans;
  rent: RentDiagnosis;
  depth: DepthEstimate;
  /** Diagnostics that could not be produced, and why. */
  impossible: { section: string; reason: string }[];
}
