/**
 * Offline ports for DETECTIVE tests: a fake read-only RPC and a fake DEX Screener serving frozen fixtures.
 * Nothing here touches the network.
 */

import type { ReadRpc } from "../../src/detective/meter.ts";
import type { DexPort } from "../../src/detective/resolve.ts";
import type { ParsedTransaction, RawAccount, SignatureInfo } from "../../src/onchain/rpc.ts";
import { ACCOUNTS, DEX_PRICES, EPOCH, F_TICK_ARRAYS, MINTS, POOLS, SNAPSHOT_SLOT } from "./../fixtures/social/depth/raw.ts";

export interface FakeRpcOptions {
  accounts?: Record<string, { owner: string; data: string } | null>;
  tickArrays?: string[];
  epoch?: number;
  slot?: number;
  signatures?: Record<string, SignatureInfo[]>;
  transactions?: Record<string, ParsedTransaction>;
  /** Make a method throw (e.g. to test failures). */
  failMethods?: Record<string, string>;
}

export interface FakeRpc extends ReadRpc {
  calls: { method: string; params?: unknown }[];
}

export function fakeRpc(o: FakeRpcOptions = {}): FakeRpc {
  const calls: FakeRpc["calls"] = [];
  const rec = (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (o.failMethods?.[method]) throw new Error(o.failMethods[method]);
  };
  const raw = (a: { owner: string; data: string } | null | undefined): RawAccount | null => (a ? { owner: a.owner, lamports: 0, executable: false, data: [a.data, "base64"] } : null);
  return {
    calls,
    url: "fake://rpc",
    getParsedAccount: async (a) => (rec("getAccountInfo", a), null),
    getTokenAccountsForMint: async (p, m) => (rec("getProgramAccounts", [p, m]), []),
    getMultipleAccounts: async (addrs) => (rec("getMultipleAccounts", addrs), addrs.map((a) => raw(o.accounts?.[a]))),
    getSignatures: async (a, limit, before) => {
      rec("getSignaturesForAddress", [a, limit, before]);
      const all = o.signatures?.[a] ?? [];
      const start = before ? all.findIndex((s) => s.signature === before) + 1 : 0;
      return all.slice(start, start + limit);
    },
    getTransaction: async (s) => (rec("getTransaction", s), o.transactions?.[s] ?? null),
    getBalanceLamports: async (a) => (rec("getBalance", a), 0),
    call: async (method, params) => {
      rec(method, params);
      if (method === "getEpochInfo") return { epoch: o.epoch ?? Number(EPOCH), absoluteSlot: o.slot ?? SNAPSHOT_SLOT };
      if (method === "getProgramAccounts") return (o.tickArrays ?? []).map((t) => ({ pubkey: "x", account: { data: [t, "base64"] } }));
      throw new Error(`fakeRpc: unexpected ${method}`);
    },
  } as FakeRpc;
}

export const fixtureAccounts = ACCOUNTS as unknown as Record<string, { owner: string; data: string }>;
export const ALL_TICKS = Object.values(F_TICK_ARRAYS);

const QUOTES: Record<string, { address: string; symbol: string }> = {
  A: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  B: { address: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw", symbol: "ANTHROPIC" },
  C: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  F: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
};
const DEXES: Record<string, string> = { A: "pumpswap", B: "raydium", C: "pumpswap", F: "raydium" };

/** A DEX Screener "token pools" response for one of the four studied tokens, from the frozen prices. */
export function dexPairs(key: "A" | "B" | "C" | "F", extra: Record<string, unknown> = {}): unknown[] {
  const p = DEX_PRICES[key]!;
  return [
    {
      chainId: "solana",
      dexId: DEXES[key],
      pairAddress: POOLS[key],
      url: `https://dexscreener.com/solana/${POOLS[key]}`,
      baseToken: { address: MINTS[key], name: `Token ${key}`, symbol: key },
      quoteToken: QUOTES[key],
      priceNative: p.priceNative,
      priceUsd: p.priceUsd,
      liquidity: { usd: p.liquidityUsd },
      volume: { h24: 1000 },
      txns: { h24: { buys: 10, sells: 8 } },
      fdv: p.fdv,
      marketCap: p.marketCap,
      pairCreatedAt: 1791546219000,
      info: { imageUrl: "https://cdn.example/x.png", websites: [{ url: "https://example.org/coin", label: "Website" }], socials: [{ type: "twitter", url: "https://x.com/example/status/1" }] },
      ...extra,
    },
  ];
}

export function fakeDex(byMint: Record<string, unknown>): DexPort & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    getTokenPools: async (_chain, mint) => {
      requests.push(mint);
      if (!(mint in byMint)) throw new Error("fakeDex: unknown token");
      return byMint[mint];
    },
  };
}
export { MINTS, POOLS, EPOCH, SNAPSHOT_SLOT };

import type { collectOnchain } from "../../src/onchain/collect.ts";
import type { OnchainData } from "../../src/onchain/types.ts";

/** A minimal on-chain collection result (what the scanner's collector would have returned), without any network. */
export const stubCollect: typeof collectOnchain = async (_rpc, target) => {
  const data: OnchainData = {
    mintAddress: target.mint,
    pairAddress: target.pairAddress,
    dexId: target.dexId,
    fetchedAt: 0,
    rpcUrl: "fake://rpc",
    mintInfo: { status: "ok", value: { program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6, supplyRaw: "1000000000000000", mintAuthority: null, freezeAuthority: null, extensions: [] } },
    holders: { status: "unavailable", error: "non lu (test hors réseau)" },
    owners: { status: "unavailable", error: "non lu (test hors réseau)" },
    creator: { status: "not_found", reason: "non lu (test hors réseau)" },
    creatorActivity: { status: "not_found", reason: "non lu (test hors réseau)" },
    wallets: { status: "unavailable", error: "non lu (test hors réseau)" },
  };
  return data;
};
