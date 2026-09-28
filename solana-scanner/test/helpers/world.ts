/** Offline Solana fixture shared by the structural bridge and UI history tests. */
import { base58Encode } from "../../src/onchain/base58.ts";
import { findRelatedWallets } from "../../src/onchain/clusters.ts";
import type { ParsedTransaction, SignatureInfo } from "../../src/onchain/rpc.ts";
import type { WalletHistory } from "../../src/onchain/types.ts";
import type { WalletRpc } from "../../src/wallets/collect.ts";

export const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
export const MINT = key(1);
export const PAIR = key(2);
export const POOL = key(3);
export const CREATOR = key(4);
export const SINK = key(5);
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const SYSTEM = "11111111111111111111111111111111";
export const W = Array.from({ length: 8 }, (_, i) => key(20 + i)); // buyers
export const H = Array.from({ length: 3 }, (_, i) => key(50 + i)); // Step 3 holders, not buyers
export const T0 = 1_790_000_000;
export const HOUR = 3600;

export function ptx(sig: string, slot: number, time: number, signer: string, lamports: Record<string, number>, tokens: { owner: string; delta: bigint }[], program: string): ParsedTransaction {
  const accounts = [...new Set([signer, ...Object.keys(lamports)])];
  const tb = (owner: string, amount: bigint, i: number) => ({ accountIndex: i, mint: MINT, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null } });
  return {
    slot,
    blockTime: time,
    transaction: { signatures: [sig], message: { accountKeys: accounts.map((a) => ({ pubkey: a, signer: a === signer, writable: true })), instructions: [{ programId: program }] } },
    meta: { err: null, fee: 5000, preBalances: accounts.map(() => 100e9), postBalances: accounts.map((a) => 100e9 + (lamports[a] ?? 0)), preTokenBalances: tokens.map((t, i) => tb(t.owner, 1_000_000_000_000n, 10 + i)), postTokenBalances: tokens.map((t, i) => tb(t.owner, 1_000_000_000_000n + t.delta, 10 + i)) },
  };
}

/**
 * Offline chain: 8 buyers (distinct funders, one hour apart), 3 holders H
 * (distinct funders) that appear together in one "bundle" transaction.
 * `h2Long`: H2 has 400 more transactions (older and newer than the bundle),
 * so its Step 4 history is incomplete and the bundle is outside what QUICK reads.
 * `w0InGroup`: buyer W0 is also in the bundle (and so in the Step 3 group).
 */
export function world(o: { h2Long?: boolean; w0InGroup?: boolean } = {}) {
  const txs = new Map<string, ParsedTransaction>();
  const sigsOf = new Map<string, SignatureInfo[]>();
  let slot = 1;
  const put = (t: ParsedTransaction, addrs: string[]) => {
    txs.set(t.transaction.signatures[0], t);
    for (const a of addrs) sigsOf.set(a, [{ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null }, ...(sigsOf.get(a) ?? [])]);
  };
  const fundTimes = new Map<string, number>();
  // Holders funded 5 days before launch, one hour apart, distinct funders.
  H.forEach((h, j) => {
    const f = key(60 + j);
    const t = T0 - 5 * 86_400 + j * HOUR;
    fundTimes.set(h, t);
    put(ptx(`hfund-${j}`, slot++, t, f, { [f]: -1e9, [h]: 1e9 }, [], SYSTEM), [h]);
  });
  if (o.h2Long) for (let k = 0; k < 30; k++) put(ptx(`old-${k}`, slot++, T0 - 4 * 86_400 + k, H[2], { [H[2]]: -1000, [SINK]: 1000 }, [], SYSTEM), [H[2]]);
  const bundleMembers = o.w0InGroup ? [...H, W[0]] : [...H];
  // W0 must exist before the bundle when it is in it.
  const buyerFundBase = o.w0InGroup ? T0 - 6 * 86_400 : T0 - 86_400;
  W.forEach((w, i) => {
    const f = key(40 + i);
    const t = buyerFundBase + i * HOUR;
    fundTimes.set(w, t);
    put(ptx(`fund-${i}`, slot++, t, f, { [f]: -1e9, [w]: 1e9 }, [], SYSTEM), [w]);
  });
  const bundle = ptx("bundle", slot++, T0 - 2 * 86_400, H[0], Object.fromEntries([...bundleMembers.map((a) => [a, -1_000_000]), [SINK, bundleMembers.length * 1_000_000]]), [], SYSTEM);
  put(bundle, bundleMembers);
  if (o.h2Long) for (let k = 0; k < 370; k++) put(ptx(`new-${k}`, slot++, T0 - 86_400 + 60 + k, H[2], { [H[2]]: -1000, [SINK]: 1000 }, [], SYSTEM), [H[2]]);
  W.forEach((w, i) => {
    const sol = i < 4 ? 0.1 : 1 - (i - 4) * 0.1;
    put(ptx(`buy-${i}`, slot++, T0 + i * 10, w, { [w]: -sol * 1e9, [POOL]: sol * 1e9 }, [{ owner: w, delta: 1_000_000n }, { owner: POOL, delta: -1_000_000n }], PUMP), [w, MINT]);
  });

  let calls = 0;
  /** Browser/public RPC calls per address or signature. */
  const byTarget = new Map<string, number>();
  const rpc: WalletRpc = {
    url: "offline",
    async getSignatures(address: string, limit: number, before?: string) {
      calls++;
      byTarget.set(address, (byTarget.get(address) ?? 0) + 1);
      const list = sigsOf.get(address) ?? [];
      const start = before ? list.findIndex((s) => s.signature === before) + 1 : 0;
      return list.slice(start, start + limit);
    },
    async getTransaction(signature: string) {
      calls++;
      byTarget.set(signature, (byTarget.get(signature) ?? 0) + 1);
      return txs.get(signature) ?? null;
    },
  };

  // Step 3 facts, produced by Step 3's own relationship logic from the holders' histories.
  const pct: Record<string, number> = { [H[0]]: 3, [H[1]]: 2.5, [H[2]]: 2 };
  const step3Wallets: WalletHistory[] = [...H, ...(o.w0InGroup ? [W[0]] : [])].map((a, j) => ({
    address: a,
    pct: pct[a] ?? 0.5,
    signatureCount: sigsOf.get(a)!.length,
    historyComplete: true,
    firstSeen: fundTimes.get(a)! * 1000,
    funder: a === W[0] ? key(40) : key(60 + j),
    fundingSignature: a === W[0] ? "fund-0" : `hfund-${j}`,
    funderSignatureCount: null,
    signatures: sigsOf.get(a)!.map((s) => s.signature),
  }));
  const related = findRelatedWallets(step3Wallets, { closeCreationMinutes: 10, busyFunderSignatures: 1000 });
  const onchain: any = {
    data: {
      owners: { status: "error" },
      mintInfo: { status: "ok", value: { supplyRaw: "1000000000000000", decimals: 6 } },
      creator: { status: "ok", value: { address: CREATOR } },
      holders: { status: "ok", value: { pctByOwner: pct } },
      wallets: { status: "ok", value: step3Wallets },
      creatorActivity: { status: "ok", value: { events: [] } },
    },
    analysis: { related },
  };
  return { rpc, onchain, related, calls: () => calls, byTarget };
}


export type World = ReturnType<typeof world>;
export const row: any = { pair: { tokenAddress: MINT, pairAddress: PAIR, dexId: "pumpswap", tokenSymbol: "TEST" } };
export const dex: any = { getPairsByTokenAddresses: async () => { throw new Error("offline"); } };
