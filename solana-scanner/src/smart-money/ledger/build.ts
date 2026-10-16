/**
 * HistoryTx[] → Ledger for one wallet. Reuses the history layer's types,
 * `walletSolFlow` (native + wrapped SOL) and `NON_SWAP_PROGRAMS`; the
 * provider's own labels are never read.
 *
 * SOL trades are priced on the TRADING flow: network fee, configured tips and identified
 * rent (ATA deposits / refunds, see rent.ts) are separated; rent that cannot be
 * attributed is flagged `uncertain` instead of being guessed.
 *
 * Rules (nothing is priced unless unambiguous):
 *  - exactly one non-quote token moved + one quote leg (SOL xor USDC/USDT)
 *    in the direction a trade implies  → trade;
 *  - the wallet is not a signer, only non-swap programs ran, or there is no
 *    quote leg                         → transfer (cost / proceeds UNKNOWN);
 *  - several tokens, SOL and stablecoin together, or a quote leg going the
 *    wrong way                         → undecodable (movement kept, price not).
 */

import { NON_SWAP_PROGRAMS, walletSolFlow } from "../../history/classify.ts";
import type { HistoryTx } from "../../history/types.ts";
import { WSOL_MINT } from "../../wallets/trades.ts";
import { DEFAULT_THRESHOLDS } from "../config.ts";
import type { SmartMoneyThresholds } from "../config.ts";
import { STABLE_MINTS } from "./mints.ts";
import { ATA_PROGRAM, detectRent } from "./rent.ts";
import type { IgnoredTx, Ledger, LedgerEntry, Leg } from "./types.ts";

export interface BuildOptions {
  thresholds?: Pick<SmartMoneyThresholds, "solNoiseSol" | "solDustSol" | "stableNoiseUsd">;
  tipAccounts?: string[];
}

/** Same rule as the history classifier: a signer, or (enhanced decoding) a wallet whose lamports went down. */
function isSigner(tx: HistoryTx, wallet: string): boolean {
  if (tx.signers.includes(wallet)) return true;
  return !tx.signersComplete && (tx.lamportDeltas[wallet] ?? 0) < 0;
}

function stableUsd(tx: HistoryTx, wallet: string): number {
  let usd = 0;
  for (const mint of STABLE_MINTS) {
    const d = tx.tokenDeltas[wallet]?.[mint];
    if (d) usd += Number(BigInt(d.raw)) / 10 ** d.decimals;
  }
  return usd;
}

function tipLamports(tx: HistoryTx, wallet: string, tipAccounts: Set<string>): number {
  if (tipAccounts.size === 0 || (tx.lamportDeltas[wallet] ?? 0) >= 0) return 0;
  let tip = 0;
  for (const [account, delta] of Object.entries(tx.lamportDeltas)) if (tipAccounts.has(account) && delta > 0) tip += delta;
  return tip;
}

export function buildLedger(wallet: string, txs: HistoryTx[], o: BuildOptions = {}): Ledger {
  const th = o.thresholds ?? DEFAULT_THRESHOLDS;
  const tipSet = new Set(o.tipAccounts ?? []);
  const ignored: IgnoredTx[] = [];
  const entries: LedgerEntry[] = [];
  let failedFeeLamports = 0;
  let failedTxCount = 0;
  const otherCosts = { feeLamports: 0, rentDepositLamports: 0, rentRefundLamports: 0, uncertainRentTxs: 0 };

  const seen = new Set<string>();
  const ordered = [...txs].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || (a.slot ?? Infinity) - (b.slot ?? Infinity) || (a.signature < b.signature ? -1 : 1));

  for (const tx of ordered) {
    if (seen.has(tx.signature)) {
      ignored.push({ signature: tx.signature, reason: "duplicate" });
      continue;
    }
    seen.add(tx.signature);
    if (tx.time === null) {
      ignored.push({ signature: tx.signature, reason: "no_block_time" });
      continue;
    }
    const feeLamports = tx.feePayer === wallet ? tx.fee : 0;
    if (tx.failed) {
      failedFeeLamports += feeLamports;
      failedTxCount++;
      ignored.push({ signature: tx.signature, reason: "failed" });
      continue;
    }

    const legs: Leg[] = Object.entries(tx.tokenDeltas[wallet] ?? {})
      .filter(([mint, d]) => mint !== WSOL_MINT && !STABLE_MINTS.has(mint) && BigInt(d.raw) !== 0n)
      .map(([mint, d]) => ({ mint, raw: d.raw, decimals: d.decimals }));
    const rent = detectRent(tx, wallet);
    if (legs.length === 0) {
      otherCosts.feeLamports += feeLamports;
      otherCosts.rentDepositLamports += rent.depositLamports;
      otherCosts.rentRefundLamports += rent.refundLamports;
      if (rent.status === "uncertain") otherCosts.uncertainRentTxs++;
      ignored.push({ signature: tx.signature, reason: "no_token_change" });
      continue;
    }

    const tip = tipLamports(tx, wallet, tipSet);
    const base = {
      signature: tx.signature, slot: tx.slot, time: tx.time, feeLamports, tipLamports: tip,
      rentDepositLamports: rent.depositLamports, rentRefundLamports: rent.refundLamports, rentStatus: rent.status,
      flags: tx.programIds.includes(ATA_PROGRAM) ? ["ata_program_present"] : [],
    };
    const sol = walletSolFlow(tx, wallet);
    // What the wallet's SOL moved by once network fee, tip and identified rent are taken out: the trading flow.
    const solExFee = sol + (feeLamports + tip + rent.depositLamports - rent.refundLamports) / 1e9;
    const usd = stableUsd(tx, wallet);
    const solMoves = Math.abs(solExFee) >= (rent.status === "identified" ? th.solDustSol : th.solNoiseSol);
    const usdMoves = Math.abs(usd) >= th.stableNoiseUsd;

    if (legs.length > 1) {
      const swapLike = legs.length === 2 && (BigInt(legs[0].raw) > 0n) !== (BigInt(legs[1].raw) > 0n) && !solMoves && !usdMoves;
      entries.push({ ...base, kind: "undecodable", reason: swapLike ? "token_to_token" : "multi_token", legs });
      continue;
    }

    const leg = legs[0];
    const raw = BigInt(leg.raw);
    const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
    const abs = (raw < 0n ? -raw : raw).toString();
    const tokenAmount = Number(abs) / 10 ** leg.decimals;
    const swapProgram = !(tx.programIds.length > 0 && tx.programIds.every((p) => NON_SWAP_PROGRAMS.has(p)));
    const signer = isSigner(tx, wallet);

    if (!signer || !swapProgram || (!solMoves && !usdMoves)) {
      const reason = !signer ? "not_signer" : !swapProgram ? "no_swap_program" : "no_quote_leg";
      entries.push({ ...base, kind: "transfer", direction: side === "buy" ? "in" : "out", mint: leg.mint, decimals: leg.decimals, tokenRaw: abs, tokenAmount, reason });
      continue;
    }
    if (solMoves && usdMoves) {
      entries.push({ ...base, kind: "undecodable", reason: "ambiguous_quote", legs });
      continue;
    }
    const quoteFlow = solMoves ? solExFee : usd;
    if ((side === "buy" && quoteFlow >= 0) || (side === "sell" && quoteFlow <= 0)) {
      entries.push({ ...base, kind: "undecodable", reason: "quote_wrong_direction", legs });
      continue;
    }
    const trade = { ...base, kind: "trade" as const, side, mint: leg.mint, decimals: leg.decimals, tokenRaw: abs, tokenAmount };
    if (solMoves) {
      entries.push({ ...trade, quote: { asset: "SOL", amount: Math.abs(solExFee) }, allInSol: side === "buy" ? -sol : sol, unconvertedFeeSol: 0 });
    } else {
      entries.push({ ...trade, quote: { asset: "USD", amount: Math.abs(usd) }, allInSol: null, unconvertedFeeSol: (feeLamports + tip) / 1e9 });
    }
  }
  return { wallet, entries, ignored, failedFeeLamports, failedTxCount, otherCosts };
}
