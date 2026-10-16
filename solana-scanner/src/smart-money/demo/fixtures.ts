/**
 * FICTIONAL data: a synthetic HistoryTx builder and a demo wallet. Nothing
 * here comes from the chain. Used by the demo command and by the tests.
 */

import type { HistoryTx } from "../../history/types.ts";
import { base58Encode } from "../../onchain/base58.ts";
import { WSOL_MINT } from "../../wallets/trades.ts";
import { USDC_MINT } from "../ledger/mints.ts";
import { ATA_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../ledger/rent.ts";

export const addr = (n: number): string => base58Encode(new Uint8Array(32).fill(n));
export const DEX_PROGRAM = addr(200);
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface TxSpec {
  sig: string;
  time: number;
  slot?: number;
  wallet: string;
  /** Net SOL change of the wallet, fee included (negative = spent). */
  sol?: number;
  /** Token changes in UI units (positive = received). */
  tokens?: Record<string, { ui: number; decimals?: number }>;
  programs?: string[];
  fee?: number;
  signer?: boolean;
  failed?: boolean;
  /** Other lamport movements (e.g. a tip account receiving). */
  extraLamports?: Record<string, number>;
}

export function tx(s: TxSpec): HistoryTx {
  const fee = s.fee ?? 5000;
  const tokenDeltas: HistoryTx["tokenDeltas"] = {};
  for (const [mint, t] of Object.entries(s.tokens ?? {})) {
    const decimals = t.decimals ?? (mint === USDC_MINT ? 6 : 6);
    (tokenDeltas[s.wallet] ??= {})[mint] = { raw: BigInt(Math.round(t.ui * 10 ** decimals)).toString(), decimals };
  }
  const lamportDeltas: Record<string, number> = { ...(s.extraLamports ?? {}) };
  if (s.sol !== undefined && s.sol !== 0) lamportDeltas[s.wallet] = Math.round(s.sol * 1e9);
  return {
    signature: s.sig,
    slot: s.slot ?? Math.floor(s.time / 400),
    time: s.time,
    failed: s.failed ?? false,
    feePayer: s.wallet,
    signers: s.signer === false ? [addr(250)] : [s.wallet],
    signersComplete: true,
    fee,
    lamportDeltas,
    tokenDeltas,
    programIds: s.programs ?? [DEX_PROGRAM],
    origin: "helius-gtfa",
    providerHint: null,
  };
}

/** Buy `ui` tokens paying `sol` SOL all-in. */
export const buy = (sig: string, time: number, wallet: string, mint: string, ui: number, sol: number): HistoryTx => tx({ sig, time, wallet, sol: -sol, tokens: { [mint]: { ui } } });
/** Sell `ui` tokens receiving `sol` SOL net. */
export const sell = (sig: string, time: number, wallet: string, mint: string, ui: number, sol: number): HistoryTx => tx({ sig, time, wallet, sol, tokens: { [mint]: { ui: -ui } } });

export { ATA_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS, USDC_MINT, WSOL_MINT };

const RENT_SOL = TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9;

/** Buy that also creates the wallet's token account: `sol` is the trading cost (fee included), the rent is on top. */
export const buyCreatingAta = (sig: string, time: number, wallet: string, mint: string, ui: number, sol: number, ataAccount = addr(240)): HistoryTx =>
  tx({ sig, time, wallet, sol: -(sol + RENT_SOL), tokens: { [mint]: { ui } }, programs: [DEX_PROGRAM, ATA_PROGRAM], extraLamports: { [ataAccount]: TOKEN_ACCOUNT_RENT_LAMPORTS } });

/** Sell that also closes the token account and gets its rent back. */
export const sellClosingAta = (sig: string, time: number, wallet: string, mint: string, ui: number, sol: number, ataAccount = addr(240)): HistoryTx =>
  tx({ sig, time, wallet, sol: sol + RENT_SOL, tokens: { [mint]: { ui: -ui } }, extraLamports: { [ataAccount]: -TOKEN_ACCOUNT_RENT_LAMPORTS } });

/** Small deterministic PRNG so the demo is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_START = Date.UTC(2026, 8, 1, 12, 0, 0);

/** A fictional wallet: 24 clean SOL round trips plus every awkward case the engine must keep UNKNOWN. */
export function demoWalletTxs(wallet = addr(11)): HistoryTx[] {
  const rnd = mulberry32(42);
  const out: HistoryTx[] = [];
  let t = DEMO_START;
  const step = (min: number) => (t += min * 60_000);
  for (let i = 0; i < 24; i++) {
    const mint = addr(30 + i);
    const cost = Math.round((0.3 + rnd() * 1.2) * 1000) / 1000;
    const mult = rnd() < 0.55 ? 1.3 + rnd() * 2.5 : 0.25 + rnd() * 0.6;
    const proceeds = Math.round(cost * mult * 1000) / 1000;
    // The first 6 positions also create / close the token account: rent is separated from trading.
    out.push((i < 6 ? buyCreatingAta : buy)(`demo-b${i}`, step(180), wallet, mint, 1_000_000, cost));
    out.push((i < 6 ? sellClosingAta : sell)(`demo-s${i}`, step(20 + Math.floor(rnd() * 200)), wallet, mint, 1_000_000, proceeds));
  }
  // USDC-quoted round trip (not added to SOL).
  const usdcMint = addr(90);
  out.push(tx({ sig: "demo-u-b", time: step(60), wallet, sol: -0.00001, tokens: { [usdcMint]: { ui: 5000 }, [USDC_MINT]: { ui: -100 } } }));
  out.push(tx({ sig: "demo-u-s", time: step(90), wallet, sol: -0.00001, tokens: { [usdcMint]: { ui: -5000 }, [USDC_MINT]: { ui: 130 } } }));
  // Received by transfer, then sold: the cost is unknown, so the result is.
  const gift = addr(91);
  out.push(tx({ sig: "demo-t-in", time: step(30), wallet, signer: false, tokens: { [gift]: { ui: 2_000_000 } } }));
  out.push(sell("demo-t-sell", step(60), wallet, gift, 2_000_000, 3.2));
  // Sold something never seen bought (older than the window).
  out.push(sell("demo-orphan", step(30), wallet, addr(92), 777, 1.5));
  // Multi-token route: tokens moved, price cannot be attributed.
  out.push(tx({ sig: "demo-route", time: step(30), wallet, sol: -0.5, tokens: { [addr(93)]: { ui: 10 }, [addr(94)]: { ui: 20 } } }));
  // A failed swap: fee burned, no position.
  out.push(tx({ sig: "demo-failed", time: step(5), wallet, sol: -0.000005, failed: true }));
  // Rent that cannot be attributed (a co-signer is present): the round is PARTIAL, not a misleading PnL.
  const coSigned = addr(96);
  out.push({ ...buyCreatingAta("demo-cs-b", step(30), wallet, coSigned, 1000, 0.5, addr(241)), signers: [wallet, addr(251)] });
  out.push(sell("demo-cs-s", step(40), wallet, coSigned, 1000, 0.9));
  // Still held (open position).
  out.push(buy("demo-open", step(45), wallet, addr(95), 500_000, 0.8));
  return out;
}
