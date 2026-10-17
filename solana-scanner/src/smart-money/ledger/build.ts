/**
 * HistoryTx[] → Ledger for one wallet (engine v2). Reuses the history layer's types, `walletSolFlow` (native + wrapped SOL)
 * and `NON_SWAP_PROGRAMS`; the provider's own labels are never read.
 *
 * A SOL trade is priced on the wallet's TRADING flow: network fee, configured tips and PROVEN rent (see rent.ts) are taken
 * out. A trade is recognised by RELATIONS, not by an amount:
 *  - swap proven: exactly one non-quote token moved for the wallet, a counterparty (pool, curve, other trader) moved it the
 *    other way and received (buy) / paid out (sell) the quote asset, and the wallet's own balance went the matching way.
 *    A 0.0017 SOL buy is a buy; a rent-only airdrop is not.
 *  - otherwise the previous wallet-side rule applies (amount thresholds), labelled `wallet_side_only`.
 * Nothing is priced from thin air: a leg that cannot be attributed stays a transfer or an undecodable entry, and unproven
 * rent makes the position PARTIAL.
 */

import { NON_SWAP_PROGRAMS, walletSolFlow } from "../../history/classify.ts";
import type { HistoryTx } from "../../history/types.ts";
import { WSOL_MINT } from "../../wallets/trades.ts";
import { DEFAULT_THRESHOLDS } from "../config.ts";
import type { SmartMoneyThresholds } from "../config.ts";
import { swapEvidence } from "./evidence.ts";
import { STABLE_MINTS } from "./mints.ts";
import { ATA_PROGRAM, assessRent } from "./rent.ts";
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

/** 1,000 lamports: below this a counterparty movement is not a payment. */
const PROOF_SOL = 1e-6;
const PROOF_USD = 1e-4;

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
    const rent = assessRent(tx, wallet);
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
      thirdPartyRentLamports: rent.thirdPartyDepositLamports,
      rentReasons: rent.reasons,
      flags: tx.programIds.includes(ATA_PROGRAM) ? ["ata_program_present"] : [],
    };
    const sol = walletSolFlow(tx, wallet);
    // What the wallet's SOL moved by once network fee, tip and PROVEN rent are taken out: the trading flow.
    const solExFee = sol + (feeLamports + tip + rent.depositLamports - rent.refundLamports) / 1e9;
    const usd = stableUsd(tx, wallet);
    const noise = rent.status === "identified" ? th.solDustSol : th.solNoiseSol;

    if (legs.length > 1) {
      const solMovesM = Math.abs(solExFee) >= noise;
      const usdMovesM = Math.abs(usd) >= th.stableNoiseUsd;
      const swapLike = legs.length === 2 && (BigInt(legs[0].raw) > 0n) !== (BigInt(legs[1].raw) > 0n) && !solMovesM && !usdMovesM;
      entries.push({ ...base, kind: "undecodable", reason: swapLike ? "token_to_token" : "multi_token", legs, reasons: [swapLike ? "token_to_token" : "multi_token"] });
      continue;
    }

    const leg = legs[0];
    const raw = BigInt(leg.raw);
    const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
    const abs = (raw < 0n ? -raw : raw).toString();
    const tokenAmount = Number(abs) / 10 ** leg.decimals;
    const swapProgram = !(tx.programIds.length > 0 && tx.programIds.every((p) => NON_SWAP_PROGRAMS.has(p)));
    const signer = isSigner(tx, wallet);
    const transferBase = { ...base, kind: "transfer" as const, direction: side === "buy" ? ("in" as const) : ("out" as const), mint: leg.mint, decimals: leg.decimals, tokenRaw: abs, tokenAmount };

    if (!signer || !swapProgram) {
      entries.push({ ...transferBase, reason: !signer ? "not_signer" : "no_swap_program", reasons: [!signer ? "not_signer" : "no_swap_program"] });
      continue;
    }

    // ── Swap proof by relations ──────────────────────────────────────
    const ev = swapEvidence(tx, wallet, leg.mint, raw);
    const buy = side === "buy";
    const solProof = ev.counterparties.length > 0 && (buy ? ev.paymentSol > PROOF_SOL && solExFee < -PROOF_SOL : ev.paymentSol < -PROOF_SOL && solExFee > PROOF_SOL);
    const usdProof = ev.counterparties.length > 0 && (buy ? ev.paymentUsd > PROOF_USD && usd < -PROOF_USD : ev.paymentUsd < -PROOF_USD && usd > PROOF_USD);
    const paidElsewhere = ev.counterparties.length > 0 && !solProof && !usdProof && (buy ? ev.paymentSol > PROOF_SOL && solExFee >= -PROOF_SOL : ev.paymentSol < -PROOF_SOL && solExFee <= PROOF_SOL);

    if (solProof && usdProof) {
      entries.push({ ...base, kind: "undecodable", reason: "ambiguous_quote", legs, swapProof: "counterparty_payment", reasons: ["ambiguous_quote", "counterparty_moved_sol_and_stable"] });
      continue;
    }
    if (paidElsewhere) {
      entries.push({ ...base, kind: "undecodable", reason: "payment_not_with_wallet", legs, swapProof: "counterparty_payment", reasons: ["payment_not_with_wallet", buy ? "pool_received_sol_but_wallet_did_not_pay" : "pool_paid_sol_but_wallet_did_not_receive"] });
      continue;
    }
    if (solProof || usdProof) {
      const trade = { ...base, kind: "trade" as const, side, mint: leg.mint, decimals: leg.decimals, tokenRaw: abs, tokenAmount, swapProof: "counterparty_payment" as const };
      const why = [`swap_proven:${ev.counterparties.length}_counterparty`];
      if (solProof) {
        if (Math.abs(solExFee) < th.solNoiseSol) why.push("micro_trade_kept");
        entries.push({ ...trade, quote: { asset: "SOL", amount: Math.abs(solExFee) }, allInSol: buy ? -sol : sol, unconvertedFeeSol: 0, poolSideAmount: Math.abs(ev.paymentSol), reasons: why });
      } else {
        if (Math.abs(usd) < th.stableNoiseUsd * 10) why.push("micro_trade_kept");
        entries.push({ ...trade, quote: { asset: "USD", amount: Math.abs(usd) }, allInSol: null, unconvertedFeeSol: (feeLamports + tip) / 1e9, poolSideAmount: Math.abs(ev.paymentUsd), reasons: why });
      }
      continue;
    }

    // ── No proof: the wallet-side rule (thresholds), labelled as such ──
    const solMoves = Math.abs(solExFee) >= noise;
    const usdMoves = Math.abs(usd) >= th.stableNoiseUsd;
    const wsOnly = { swapProof: "wallet_side_only" as const };
    if (!solMoves && !usdMoves) {
      entries.push({ ...transferBase, reason: "no_quote_leg", ...wsOnly, reasons: ev.counterparties.length > 0 ? ["no_quote_leg", "counterparty_without_payment"] : ["no_quote_leg", "no_counterparty"] });
      continue;
    }
    if (solMoves && usdMoves) {
      entries.push({ ...base, kind: "undecodable", reason: "ambiguous_quote", legs, ...wsOnly, reasons: ["ambiguous_quote"] });
      continue;
    }
    const quoteFlow = solMoves ? solExFee : usd;
    if ((buy && quoteFlow >= 0) || (!buy && quoteFlow <= 0)) {
      entries.push({ ...base, kind: "undecodable", reason: "quote_wrong_direction", legs, ...wsOnly, reasons: ["quote_wrong_direction"] });
      continue;
    }
    const trade = { ...base, kind: "trade" as const, side, mint: leg.mint, decimals: leg.decimals, tokenRaw: abs, tokenAmount, ...wsOnly };
    const why = ["wallet_side_only", ev.counterparties.length > 0 ? "counterparty_in_other_asset" : "no_counterparty"];
    if (solMoves) entries.push({ ...trade, quote: { asset: "SOL", amount: Math.abs(solExFee) }, allInSol: buy ? -sol : sol, unconvertedFeeSol: 0, poolSideAmount: null, reasons: why });
    else entries.push({ ...trade, quote: { asset: "USD", amount: Math.abs(usd) }, allInSol: null, unconvertedFeeSol: (feeLamports + tip) / 1e9, poolSideAmount: null, reasons: why });
  }
  return { wallet, entries, ignored, failedFeeLamports, failedTxCount, otherCosts };
}
