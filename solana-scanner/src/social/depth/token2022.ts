/**
 * SPL Token-2022 TransferFee extension: epoch-dependent fee schedule and exact fee calculation.
 * Reference: spl-token-2022 extension/transfer_fee (calculate_epoch_fee / TransferFee::calculate_fee).
 */

import { mulDivCeil } from "./math.ts";

export interface TransferFeeSchedule {
  /** Fee that applies before `newerEpoch`. */
  olderEpoch: bigint;
  olderBps: number;
  olderMax: bigint;
  /** Fee that applies from `newerEpoch` on. */
  newerEpoch: bigint;
  newerBps: number;
  newerMax: bigint;
}

export interface TransferFee {
  bps: number;
  maximumFee: bigint;
}

/** The schedule entry in force at `epoch`: the newer one once its epoch has been reached. */
export function feeAtEpoch(s: TransferFeeSchedule, epoch: bigint): TransferFee {
  return epoch >= s.newerEpoch ? { bps: s.newerBps, maximumFee: s.newerMax } : { bps: s.olderBps, maximumFee: s.olderMax };
}

/** fee = min(ceil(amount × bps / 10000), maximumFee); 0 when the rate or the amount is 0. */
export function transferFee(amount: bigint, fee: TransferFee | null): bigint {
  if (fee === null || fee.bps === 0 || amount <= 0n) return 0n;
  const raw = mulDivCeil(amount, BigInt(fee.bps), 10_000n);
  return raw < fee.maximumFee ? raw : fee.maximumFee;
}

/** What the recipient gets when `amount` is sent. */
export function afterTransferFee(amount: bigint, fee: TransferFee | null): bigint {
  return amount - transferFee(amount, fee);
}
