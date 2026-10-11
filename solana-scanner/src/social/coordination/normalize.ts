/**
 * Boundary with the outside world: turns a Solana RPC `getTransaction` result (encoding "jsonParsed",
 * maxSupportedTransactionVersion 0) into a NormalizedTx, and a NormalizedTx into SwapEvents.
 * Only the fields listed in `RawTx` are read; anything else is ignored. Malformed input throws NormalizeError
 * (a missing field is never silently replaced by a guess).
 */

import type { NormalizedTx, SolTransfer, SwapEvent, TokenDelta } from "./model.ts";
import { DEX_PROGRAMS, JITO_TIP_ACCOUNTS, SYSTEM_PROGRAM, WSOL_MINT } from "./entities.ts";

export class NormalizeError extends Error {
  constructor(message: string) {
    super(`normalize: ${message}`);
    this.name = "NormalizeError";
  }
}

interface RawParsedIx {
  programId?: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
export interface RawTx {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    innerInstructions?: { index: number; instructions: RawParsedIx[] }[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: ({ pubkey: string; signer: boolean } | string)[]; instructions: RawParsedIx[] };
  };
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new NormalizeError(`${what} is not a non-negative integer`);
};

export function normalizeTx(raw: RawTx): NormalizedTx {
  if (!raw || typeof raw !== "object") throw new NormalizeError("transaction is not an object");
  const meta = raw.meta;
  if (!meta) throw new NormalizeError("missing meta (transaction not confirmed or pruned)");
  const msg = raw.transaction?.message;
  const sigs = raw.transaction?.signatures;
  if (!msg || !Array.isArray(msg.accountKeys) || !Array.isArray(sigs) || sigs.length === 0) throw new NormalizeError("missing message or signatures");
  if (!Number.isInteger(raw.slot)) throw new NormalizeError("missing slot");

  const keys = msg.accountKeys.map((k) => (typeof k === "string" ? { pubkey: k, signer: false } : k));
  const n = keys.length;
  if (meta.preBalances.length !== n || meta.postBalances.length !== n) throw new NormalizeError("balance arrays do not match account keys");
  const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
  if (signers.length === 0) throw new NormalizeError("no signer");
  const feePayer = keys[0]!.pubkey;

  const solDeltas: Record<string, bigint> = {};
  for (let i = 0; i < n; i++) {
    const d = BigInt(meta.postBalances[i]!) - BigInt(meta.preBalances[i]!);
    if (d !== 0n) solDeltas[keys[i]!.pubkey] = (solDeltas[keys[i]!.pubkey] ?? 0n) + d;
  }

  const tokenMap = new Map<string, TokenDelta>();
  const addTok = (b: RawTokenBalance, sign: 1n | -1n) => {
    if (!b.owner) return; // owner unknown (very old transactions): cannot be attributed to a wallet
    const k = `${b.owner}|${b.mint}`;
    const cur = tokenMap.get(k) ?? { owner: b.owner, mint: b.mint, delta: 0n };
    cur.delta += sign * big(b.uiTokenAmount.amount, "token amount");
    tokenMap.set(k, cur);
  };
  for (const b of meta.preTokenBalances ?? []) addTok(b, -1n);
  for (const b of meta.postTokenBalances ?? []) addTok(b, 1n);
  const tokenDeltas = [...tokenMap.values()].filter((t) => t.delta !== 0n);

  const programs = new Set<string>();
  const solTransfers: SolTransfer[] = [];
  const rentByPayer: Record<string, bigint> = {};
  const blockTime = typeof raw.blockTime === "number" ? raw.blockTime : null;
  const visit = (ix: RawParsedIx) => {
    const pid = ix.programId ?? (ix.program === "system" ? SYSTEM_PROGRAM : undefined);
    if (pid) programs.add(pid);
    if (pid !== SYSTEM_PROGRAM || !ix.parsed?.info) return;
    const t = ix.parsed.type;
    const info = ix.parsed.info;
    if (t === "transfer" || t === "transferWithSeed") {
      const from = info.source;
      const to = info.destination;
      if (typeof from === "string" && typeof to === "string") solTransfers.push({ signature: sigs[0]!, slot: raw.slot, blockTime, from, to, lamports: big(info.lamports, "lamports") });
    } else if (t === "createAccount" || t === "createAccountWithSeed") {
      const from = info.source;
      if (typeof from === "string") rentByPayer[from] = (rentByPayer[from] ?? 0n) + big(info.lamports, "lamports");
    }
  };
  for (const ix of msg.instructions) visit(ix);
  for (const inner of meta.innerInstructions ?? []) for (const ix of inner.instructions) visit(ix);

  return {
    signature: sigs[0]!,
    slot: raw.slot,
    blockTime,
    failed: meta.err !== null && meta.err !== undefined,
    feePayer,
    signers,
    fee: big(meta.fee, "fee"),
    programs: [...programs].sort(),
    solDeltas,
    tokenDeltas,
    solTransfers,
    rentByPayer,
  };
}

const TIPS = new Set(JITO_TIP_ACCOUNTS);

export interface SwapExtraction {
  swap: SwapEvent | null;
  /** Why no swap was produced (for coverage notes); null when one was. */
  skipped: "failed" | "no_base_delta" | "no_dex_program" | "unattributed" | "no_signer_delta" | null;
}

/** A SOL change smaller than this is the residue of fees and rounding, not a quote leg. */
const SOL_LEG_DUST = 100_000n;

export interface SwapOptions {
  /** Quote mints expected for this token (in order of preference). Unknown → inferred from the transaction. */
  quoteMints?: readonly string[];
}

/**
 * Reads the buy or sell of `mint` made by the transaction's signer.
 *  - failed transactions moved nothing → skipped;
 *  - the trader is the signer whose own token accounts changed (the pool's vaults are never signers);
 *  - the transaction must invoke a known DEX program (otherwise it is a plain transfer, handled elsewhere);
 *  - the quote leg is the trader's opposite-sign change in SOL/wSOL (fee, account rent and Jito tips removed) or in
 *    another token; with several candidates the declared `quoteMints` order decides, else wSOL, else the largest.
 */
export function extractSwap(tx: NormalizedTx, mint: string, opts: SwapOptions = {}): SwapExtraction {
  if (tx.failed) return { swap: null, skipped: "failed" };
  const base = tx.tokenDeltas.filter((t) => t.mint === mint);
  if (base.length === 0) return { swap: null, skipped: "no_base_delta" };
  const dex = tx.programs.filter((p) => DEX_PROGRAMS[p] !== undefined);
  if (dex.length === 0) return { swap: null, skipped: "no_dex_program" };
  const signerSet = new Set(tx.signers);
  const mine = base.filter((t) => signerSet.has(t.owner));
  if (mine.length === 0) return { swap: null, skipped: "unattributed" };
  // several signers moved the token: attribute to the fee payer if it did, else to the largest mover
  const pick = mine.find((t) => t.owner === tx.feePayer) ?? mine.reduce((a, b) => ((b.delta < 0n ? -b.delta : b.delta) > (a.delta < 0n ? -a.delta : a.delta) ? b : a));
  const trader = pick.owner;
  const buy = pick.delta > 0n;

  let sol = tx.solDeltas[trader] ?? 0n;
  if (trader === tx.feePayer) sol += tx.fee;
  sol += tx.rentByPayer[trader] ?? 0n;
  for (const tr of tx.solTransfers) if (tr.from === trader && TIPS.has(tr.to)) sol += tr.lamports;
  const wsol = tx.tokenDeltas.find((t) => t.owner === trader && t.mint === WSOL_MINT)?.delta ?? 0n;
  const legs = new Map<string, bigint>([[WSOL_MINT, sol + wsol]]);
  for (const t of tx.tokenDeltas) if (t.owner === trader && t.mint !== mint && t.mint !== WSOL_MINT) legs.set(t.mint, (legs.get(t.mint) ?? 0n) + t.delta);

  // a leg that goes the right way: the trader pays when buying, is paid when selling
  const right = (d: bigint) => (buy ? d < 0n : d > 0n);
  const mag = (d: bigint) => (d < 0n ? -d : d);
  const declared = opts.quoteMints ?? [];
  let chosen: string | null = null;
  for (const m of declared) if (right(legs.get(m) ?? 0n)) { chosen = m; break; }
  if (chosen === null && declared.length === 0) {
    const cands = [...legs].filter(([m, d]) => right(d) && (m !== WSOL_MINT || mag(d) >= SOL_LEG_DUST));
    if (cands.some(([m]) => m === WSOL_MINT)) chosen = WSOL_MINT;
    else if (cands.length > 0) chosen = cands.sort((x, y) => (mag(y[1]) > mag(x[1]) ? 1 : mag(y[1]) < mag(x[1]) ? -1 : x[0] < y[0] ? -1 : 1))[0]![0];
  }
  const quoteMint = chosen ?? declared[0] ?? WSOL_MINT;
  return {
    swap: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, trader, side: buy ? "buy" : "sell", baseAmount: buy ? pick.delta : -pick.delta, quoteMint, quoteAmount: chosen === null ? 0n : mag(legs.get(chosen)!), dexPrograms: dex },
    skipped: null,
  };
}

/** Base-token transfers that are not swaps (wallet to wallet): sender → receiver pairs with amounts. */
export interface TokenTransfer {
  signature: string;
  slot: number;
  blockTime: number | null;
  from: string;
  to: string;
  amount: bigint;
}

/**
 * Wallet-to-wallet moves of `mint` in a transaction that invokes no DEX program: the owner whose balance fell is
 * the sender, the owner whose balance rose the receiver. With one sender and one receiver the pairing is exact;
 * otherwise nothing is paired (never guessed).
 */
export function extractTokenTransfer(tx: NormalizedTx, mint: string): TokenTransfer | null {
  if (tx.failed || tx.programs.some((p) => DEX_PROGRAMS[p] !== undefined)) return null;
  const d = tx.tokenDeltas.filter((t) => t.mint === mint);
  const out = d.filter((t) => t.delta < 0n);
  const inn = d.filter((t) => t.delta > 0n);
  if (out.length !== 1 || inn.length !== 1) return null;
  const amount = -out[0]!.delta;
  if (amount !== inn[0]!.delta) return null; // a tax or fee was taken: not an exact pairing
  return { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, from: out[0]!.owner, to: inn[0]!.owner, amount };
}
