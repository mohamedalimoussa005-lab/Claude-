import assert from "node:assert/strict";
import type { WalletQuality } from "../../src/wallets/profile.ts";

/** Numeric value of a measured Wallet Quality; fails the test on UNKNOWN (never an implicit 0). */
export function qv(q: WalletQuality): number {
  if (q.status !== "measured") assert.fail(`Wallet Quality not measured: ${JSON.stringify(q)}`);
  return q.value;
}
