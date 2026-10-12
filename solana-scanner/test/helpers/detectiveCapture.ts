/** A fake read-only RPC that replays a 5C capture (oldest mint transactions + wallet histories). No network. */
import type { ParsedTransaction, SignatureInfo } from "../../src/onchain/rpc.ts";
import type { FakeRpc } from "./detective.ts";
import { fakeRpc } from "./detective.ts";
import type { FakeRpcOptions } from "./detective.ts";
import type { Capture } from "./../fixtures/social/coordination/load.ts";

const dummy = (n: number, prefix: string, slot: number): SignatureInfo[] =>
  Array.from({ length: n }, (_, i) => ({ signature: `${prefix}${i}`, slot, blockTime: null, err: { InstructionError: [0, "Custom"] } }) as unknown as SignatureInfo);

const sigOf = (t: { slot: number; blockTime?: number | null; transaction: { signatures: string[] } }): SignatureInfo =>
  ({ signature: t.transaction.signatures[0]!, slot: t.slot, blockTime: t.blockTime ?? null, err: null }) as unknown as SignatureInfo;

/** Newest first. When `incomplete`, failed dummy signatures pad the listing so pages look full. */
export function replayRpc(c: Capture, opts: { mintPad?: number; extra?: FakeRpcOptions } = {}): FakeRpc {
  const transactions: Record<string, ParsedTransaction> = {};
  const signatures: Record<string, SignatureInfo[]> = {};
  const sorted = (txs: Capture["txs"]) => [...txs].sort((a, b) => b.slot - a.slot);
  for (const t of c.txs) transactions[t.transaction.signatures[0]!] = t as unknown as ParsedTransaction;
  const mintSigs = sorted(c.txs).map(sigOf);
  // padding = NEWER failed signatures (the capture holds the oldest transactions)
  signatures[c.mint] = [...dummy(opts.mintPad ?? 0, "padmint", 455_000_000), ...mintSigs];
  for (const [w, h] of Object.entries(c.wallets)) {
    for (const t of h.txs) transactions[t.transaction.signatures[0]!] = t as unknown as ParsedTransaction;
    const real = sorted(h.txs).map(sigOf);
    signatures[w] = h.coverage.signaturesComplete ? real : [...dummy(1000 - real.length, `pad${w.slice(0, 4)}`, 455_000_000), ...real];
  }
  return fakeRpc({ ...opts.extra, signatures, transactions });
}
