/**
 * Raw on-chain data collected for one token. Each section records whether it
 * was obtained; nothing unavailable is ever filled with a default value.
 */

export type Section<T> =
  | { status: "ok"; value: T }
  /** The source failed (RPC down, rate limited, unexpected data). */
  | { status: "unavailable"; error: string }
  /** The source answered but the fact could not be established. */
  | { status: "not_found"; reason: string };

export interface MintExtension {
  name: string;
  state: Record<string, unknown>;
}

export interface MintData {
  /** Token program owning the mint (SPL Token or Token-2022). */
  program: string;
  decimals: number;
  /** Raw supply (base units), as a decimal string. */
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: MintExtension[];
}

export interface HolderEntry {
  /** Wallet / account that owns the token account(s). */
  owner: string;
  amountRaw: string;
  /** % of total supply. */
  pctOfSupply: number;
  tokenAccounts: number;
}

export interface HoldersData {
  tokenAccounts: number;
  /** Owners with a non-zero balance. */
  holderCount: number;
  /** Largest owners, sorted (at most `holders.classifyTop`). */
  top: HolderEntry[];
  /** % of supply held by a given owner, for any owner (not only top). */
  pctByOwner: Record<string, number>;
}

export interface OwnerInfo {
  address: string;
  exists: boolean;
  /** Program that owns this account (System program for plain wallets). */
  program: string | null;
  executable: boolean;
  lamports: number;
  /** Base64 account data, kept only when it is decoded (pump.fun accounts). */
  data?: string;
}

export interface CreatorData {
  /** Deployment-associated wallet. Not proven to be the real developer. */
  address: string;
  method: string;
  evidence: string;
}

export interface CreatorEvent {
  signature: string;
  time: number | null;
  kind: "sell" | "transfer" | "receive" | "other";
  /** Token change for the deployment-associated wallet, % of supply (negative = out). */
  tokenDeltaPct: number;
  /** Non-technical wallets that received tokens in the same transaction. */
  recipients: string[];
}

export interface CreatorActivity {
  solBalance: number;
  /** % of supply it holds now, null when the holder list is unavailable. */
  tokenPct: number | null;
  recentSignatures: number;
  analyzedTransactions: number;
  events: CreatorEvent[];
}

export interface WalletHistory {
  address: string;
  pct: number;
  signatureCount: number;
  /** True when the whole history fits in one page, so the first transaction is known. */
  historyComplete: boolean;
  firstSeen: number | null;
  funder: string | null;
  fundingSignature: string | null;
  /** Signatures found for the funder (one page); null when not checked. A full page suggests an exchange or service. */
  funderSignatureCount?: number | null;
  signatures: string[];
}

export interface OnchainData {
  mintAddress: string;
  pairAddress: string | null;
  dexId: string | null;
  fetchedAt: number;
  rpcUrl: string;
  mintInfo: Section<MintData>;
  holders: Section<HoldersData>;
  owners: Section<Record<string, OwnerInfo>>;
  creator: Section<CreatorData>;
  creatorActivity: Section<CreatorActivity>;
  wallets: Section<WalletHistory[]>;
}
