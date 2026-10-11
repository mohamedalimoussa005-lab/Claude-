/**
 * Builders for coordination tests: valid-looking addresses and signatures, and RPC-shaped (jsonParsed) transactions.
 * No network. Every transaction is produced in the same shape `getTransaction` returns, so the normalizer under
 * test reads what it reads in production.
 */

import { createHash } from "node:crypto";
import { base58Encode } from "../../src/social/depth/bytes.ts";
import type { RawTx } from "../../src/social/coordination/normalize.ts";
import type { Coverage, NormalizedTx, SolTransfer } from "../../src/social/coordination/model.ts";
import { normalizeTx } from "../../src/social/coordination/normalize.ts";
import type { FundingProvider, WalletFundingHistory } from "../../src/social/coordination/funding.ts";

export { prng } from "./depth.ts";

const h = (label: string, n: number) => createHash("sha256").update(`${label}:${n}`).digest();
export const addr = (n: number | string): string => base58Encode(createHash("sha256").update(`addr:${n}`).digest());
export const sig = (n: number): string => base58Encode(Buffer.concat([h("sigA", n), h("sigB", n)]));

export const MINT = addr("mint");
export const POOL_OWNER = addr("pool-owner");
export const PUMP_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYS = "11111111111111111111111111111111";
const FEE = 5000n;
/** Block time of a slot: 2026-10, 0.4 s per slot around slot 400,000,000. */
export const tm = (slot: number): number => 1_791_000_000 + Math.floor((slot - 400_000_000) * 0.4);

const sysIx = (type: string, info: Record<string, unknown>) => ({ programId: SYS, program: "system", parsed: { type, info } });

export interface SwapTxArgs {
  n: number;
  slot: number;
  time?: number;
  trader: string;
  side: "buy" | "sell";
  base: bigint;
  quote: bigint;
  program?: string;
  mint?: string;
  fee?: bigint;
  /** lamports of ATA rent paid by the trader inside the tx (first buy). */
  rent?: bigint;
  /** lamports tip to this account. */
  tip?: { to: string; lamports: bigint };
  failed?: boolean;
}

export function swapTx(a: SwapTxArgs): RawTx {
  const fee = a.fee ?? FEE;
  const mint = a.mint ?? MINT;
  const buy = a.side === "buy";
  const rent = a.rent ?? 0n;
  const tip = a.tip?.lamports ?? 0n;
  const keys = [a.trader, POOL_OWNER, a.program ?? PUMP_CURVE, ...(a.tip ? [a.tip.to] : [])];
  const pre = [10_000_000_000n, 50_000_000_000n, 1n, ...(a.tip ? [1_000_000n] : [])];
  const traderDelta = (buy ? -a.quote : a.quote) - fee - rent - tip;
  const post = pre.map((p, i) => (i === 0 ? p + traderDelta : i === 1 ? p + (buy ? a.quote : -a.quote) : i === 3 ? p + tip : p));
  const inner = [{ index: 0, instructions: [...(rent > 0n ? [sysIx("createAccount", { source: a.trader, newAccount: addr("ata" + a.n), lamports: Number(rent) })] : []), ...(a.tip ? [sysIx("transfer", { source: a.trader, destination: a.tip.to, lamports: Number(tip) })] : [])] }];
  return {
    slot: a.slot,
    blockTime: a.time ?? tm(a.slot),
    meta: {
      err: a.failed ? { InstructionError: [0, "Custom"] } : null,
      fee: Number(fee),
      preBalances: pre.map(Number),
      postBalances: post.map(Number),
      preTokenBalances: [
        { accountIndex: 1, mint, owner: a.trader, uiTokenAmount: { amount: buy ? "0" : a.base.toString() } },
        { accountIndex: 1, mint, owner: POOL_OWNER, uiTokenAmount: { amount: "1000000000000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint, owner: a.trader, uiTokenAmount: { amount: buy ? a.base.toString() : "0" } },
        { accountIndex: 1, mint, owner: POOL_OWNER, uiTokenAmount: { amount: (1_000_000_000_000_000n + (buy ? -a.base : a.base)).toString() } },
      ],
      innerInstructions: inner,
    },
    transaction: { signatures: [sig(a.n)], message: { accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0 })), instructions: [{ programId: a.program ?? PUMP_CURVE }] } },
  };
}

export function solTransferTx(a: { n: number; slot: number; time?: number; from: string; to: string; lamports: bigint }): RawTx {
  return {
    slot: a.slot,
    blockTime: a.time ?? tm(a.slot),
    meta: { err: null, fee: Number(FEE), preBalances: [Number(a.lamports) + 10_000, 0], postBalances: [10_000 - Number(FEE), Number(a.lamports)], innerInstructions: [] },
    transaction: { signatures: [sig(a.n)], message: { accountKeys: [{ pubkey: a.from, signer: true }, { pubkey: a.to, signer: false }], instructions: [sysIx("transfer", { source: a.from, destination: a.to, lamports: Number(a.lamports) })] } },
  };
}

export function tokenTransferTx(a: { n: number; slot: number; from: string; to: string; amount: bigint; mint?: string }): RawTx {
  const mint = a.mint ?? MINT;
  return {
    slot: a.slot,
    blockTime: tm(a.slot),
    meta: {
      err: null,
      fee: Number(FEE),
      preBalances: [1_000_000_000, 2_039_280, 2_039_280],
      postBalances: [1_000_000_000 - Number(FEE), 2_039_280, 2_039_280],
      preTokenBalances: [
        { accountIndex: 1, mint, owner: a.from, uiTokenAmount: { amount: a.amount.toString() } },
        { accountIndex: 2, mint, owner: a.to, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint, owner: a.from, uiTokenAmount: { amount: "0" } },
        { accountIndex: 2, mint, owner: a.to, uiTokenAmount: { amount: a.amount.toString() } },
      ],
      innerInstructions: [],
    },
    transaction: { signatures: [sig(a.n)], message: { accountKeys: [{ pubkey: a.from, signer: true }, { pubkey: addr("ta1"), signer: false }, { pubkey: addr("ta2"), signer: false }], instructions: [{ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }] } },
  };
}

export const cov = (over: Partial<Coverage> = {}): Coverage => ({ signaturesComplete: true, signaturesRead: 100, transactionsRead: 100, transactionsMissing: 0, oldestSlot: 1, newestSlot: 1000, notes: [], ...over });

export const N = (raw: RawTx): NormalizedTx => normalizeTx(raw);

/** A funding provider backed by a map wallet → inbound transfers. Unknown wallets → null (history unavailable). */
export function mapProvider(map: Record<string, { from: string; lamports: bigint; slot: number; time?: number; n: number }[] | null>, opts: Record<string, Partial<WalletFundingHistory>> = {}): FundingProvider {
  return (wallet) => {
    const list = map[wallet];
    if (list === undefined || list === null) return null;
    const inbound: SolTransfer[] = list.map((t) => ({ signature: sig(t.n), slot: t.slot, blockTime: t.time ?? tm(t.slot), from: t.from, to: wallet, lamports: t.lamports }));
    return { wallet, inbound, coverage: cov(), ...opts[wallet] };
  };
}

// ---- scenario generators -------------------------------------------------------------------------------

import type { SwapEvent } from "../../src/social/coordination/model.ts";
import { WSOL_MINT } from "../../src/social/coordination/entities.ts";

export const SOL = 1_000_000_000n;
export const BASE_SLOT = 400_000_000;

export function swapEvent(n: number, slot: number, trader: string, side: "buy" | "sell", base: bigint, quote: bigint): SwapEvent {
  return { signature: sig(n), slot, blockTime: tm(slot), trader, side, baseAmount: base, quoteMint: WSOL_MINT, quoteAmount: quote, dexPrograms: [PUMP_CURVE] };
}

/** Organic launch: arrivals decay geometrically from the first slot, sizes are log-uniform and not round, no common funder. */
export function organicLaunch(rng: () => number, buyers: number, firstId = 1000, meanSlots = 12): { swaps: SwapEvent[]; wallets: string[] } {
  const swaps: SwapEvent[] = [];
  const wallets: string[] = [];
  for (let i = 0; i < buyers; i++) {
    const w = addr(`organic-${firstId}-${i}`);
    wallets.push(w);
    const slot = BASE_SLOT + Math.floor(-Math.log(1 - rng()) * meanSlots);
    const quote = BigInt(Math.floor(Math.exp(Math.log(0.05e9) + rng() * (Math.log(5e9) - Math.log(0.05e9)))));
    swaps.push(swapEvent(firstId + i, slot, w, "buy", quote * 1000n, quote));
  }
  return { swaps, wallets };
}

/** Funding provider where every wallet got its first SOL from its own distinct funder, at random times. */
export function organicFunding(rng: () => number, wallets: string[]): FundingProvider {
  const map: Record<string, { from: string; lamports: bigint; slot: number; n: number }[]> = {};
  wallets.forEach((w, i) => {
    map[w] = [{ from: addr(`funder-${w}`), lamports: BigInt(Math.floor(0.1e9 + rng() * 5e9)), slot: BASE_SLOT - 100_000 - Math.floor(rng() * 5_000_000), n: 50_000 + i }];
  });
  return mapProvider(map);
}

/** A swap whose quote leg is a token (USDC-style), not SOL: the trader's token accounts of both mints change. */
export function tokenQuoteSwapTx(a: { n: number; slot: number; trader: string; side: "buy" | "sell"; base: bigint; quote: bigint; quoteMint: string; extraQuote?: { mint: string; delta: bigint }; solDust?: bigint; program?: string }): RawTx {
  const buy = a.side === "buy";
  const bal = (owner: string, mint: string, amt: bigint) => ({ accountIndex: 1, mint, owner, uiTokenAmount: { amount: amt.toString() } });
  const big = 10n ** 18n;
  const pre = [bal(a.trader, MINT, buy ? 0n : a.base), bal(POOL_OWNER, MINT, big), bal(a.trader, a.quoteMint, buy ? a.quote : 0n), bal(POOL_OWNER, a.quoteMint, big)];
  const post = [bal(a.trader, MINT, buy ? a.base : 0n), bal(POOL_OWNER, MINT, big + (buy ? -a.base : a.base)), bal(a.trader, a.quoteMint, buy ? 0n : a.quote), bal(POOL_OWNER, a.quoteMint, big + (buy ? a.quote : -a.quote))];
  if (a.extraQuote) {
    pre.push(bal(a.trader, a.extraQuote.mint, 5_000_000n));
    post.push(bal(a.trader, a.extraQuote.mint, 5_000_000n + a.extraQuote.delta));
  }
  const dust = a.solDust ?? 0n;
  return {
    slot: a.slot,
    blockTime: tm(a.slot),
    meta: { err: null, fee: Number(FEE), preBalances: [10_000_000_000, 1], postBalances: [Number(10_000_000_000n - FEE + dust), 1], preTokenBalances: pre, postTokenBalances: post, innerInstructions: [] },
    transaction: { signatures: [sig(a.n)], message: { accountKeys: [{ pubkey: a.trader, signer: true }, { pubkey: POOL_OWNER, signer: false }], instructions: [{ programId: a.program ?? PUMPSWAP }] } },
  };
}
