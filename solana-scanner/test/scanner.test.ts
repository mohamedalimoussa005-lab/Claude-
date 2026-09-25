import { test } from "node:test";
import assert from "node:assert/strict";
import { DexScreenerError } from "../src/api/dexscreener.ts";
import { chunk, mostLiquidPairPerToken, scanSolana } from "../src/domain/scanner.ts";
import type { ScanClient } from "../src/domain/scanner.ts";
import { normalizePair } from "../src/domain/normalize.ts";
import { rawPair } from "./fixtures/pair.ts";

const ref = (chainId: string, tokenAddress: string) => ({ chainId, tokenAddress, url: "x" });
const pair = (pairAddress: string, base: string, extra: Record<string, unknown> = {}) =>
  rawPair({ pairAddress, baseToken: { address: base, name: base, symbol: base }, ...extra });

function fakeClient(overrides: Partial<ScanClient> = {}): ScanClient & { batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    getLatestTokenProfiles: async () => [ref("solana", "A"), ref("ethereum", "E"), ref("solana", "B")],
    getLatestBoostedTokens: async () => [ref("solana", "B"), ref("solana", "C")],
    getTopBoostedTokens: async () => [ref("base", "Z")],
    getPairsByTokenAddresses: async (_chain: string, addrs: string[]) => {
      batches.push(addrs);
      return [
        pair("PA1", "A", { liquidity: { usd: 100 } }),
        pair("PA2", "A", { liquidity: { usd: 5000 } }),
        pair("PB1", "B"),
        pair("PB1", "B"), // duplicate
        pair("PX", "SOLMINT"), // discovered token is on the quote side
        pair("PE", "C", { chainId: "ethereum" }),
        { garbage: true },
      ];
    },
    ...overrides,
  };
}

test("discovers unique Solana tokens and normalises their pairs", async () => {
  const client = fakeClient();
  const r = await scanSolana(client);
  assert.deepEqual(client.batches, [["A", "B", "C"]]);
  assert.deepEqual(
    r.pairs.map((p) => p.pairAddress),
    ["PA1", "PA2", "PB1"],
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats.discoveredBySource, { profiles: 2, "boosts-latest": 2, "boosts-top": 0 });
  assert.equal(r.stats.uniqueSolanaTokens, 3);
  assert.equal(r.stats.rawPairs, 7);
  assert.equal(r.stats.skippedDuplicate, 1);
  assert.equal(r.stats.skippedQuoteSide, 1);
  assert.equal(r.stats.skippedOtherChain, 1);
  assert.equal(r.stats.skippedInvalid, 1);
  assert.equal(r.stats.tokensWithoutPairs, 1); // C
});

test("batches token lookups by 30 and respects maxTokens", async () => {
  const many = Array.from({ length: 75 }, (_, i) => ref("solana", `T${i}`));
  const client = fakeClient({ getLatestTokenProfiles: async () => many });
  const r = await scanSolana(client, { maxTokens: 70 });
  assert.deepEqual(client.batches.map((b) => b.length), [30, 30, 10]);
  assert.equal(r.stats.requestedTokens, 70);
  assert.equal(r.stats.pairRequests, 3);
});

test("a failing discovery source is reported without aborting the scan", async () => {
  const client = fakeClient({
    getLatestBoostedTokens: async () => {
      throw new DexScreenerError("rate_limit", "/token-boosts/latest/v1", "Rate limited", 429, 4);
    },
  });
  const r = await scanSolana(client);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].stage, "discovery");
  assert.equal(r.errors[0].source, "boosts-latest");
  assert.equal(r.errors[0].kind, "rate_limit");
  assert.equal(r.errors[0].status, 429);
  assert.ok(r.pairs.length > 0);
});

test("everything failing yields no pairs and one error per call", async () => {
  const fail = async () => {
    throw new DexScreenerError("network", "/x", "Network error", null, 4);
  };
  const r = await scanSolana(
    fakeClient({ getLatestTokenProfiles: fail, getLatestBoostedTokens: fail, getTopBoostedTokens: fail }),
  );
  assert.equal(r.pairs.length, 0);
  assert.equal(r.errors.length, 3);
  assert.equal(r.stats.pairRequests, 0);
});

test("a failing pairs batch is reported", async () => {
  const r = await scanSolana(
    fakeClient({
      getPairsByTokenAddresses: async () => {
        throw new DexScreenerError("http", "/tokens/v1/solana/A,B,C", "HTTP 500", 500, 4);
      },
    }),
  );
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].stage, "pairs");
  assert.equal(r.stats.tokensWithoutPairs, 0);
});

test("mostLiquidPairPerToken keeps the deepest pool, missing liquidity last", () => {
  const ps = [
    normalizePair(pair("P1", "A", { liquidity: { usd: 10 } }))!,
    normalizePair(pair("P2", "A", { liquidity: { usd: 99 } }))!,
    normalizePair(pair("P3", "B", { liquidity: undefined }))!,
    normalizePair(pair("P4", "B", { liquidity: { usd: 1 } }))!,
  ];
  assert.deepEqual(mostLiquidPairPerToken(ps).map((p) => p.pairAddress), ["P2", "P4"]);
});

test("chunk splits evenly", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 30), []);
});
