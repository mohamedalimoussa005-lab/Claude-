import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPairs, extractTokenRefs, fieldCoverage, normalizePair, toNumber } from "../src/domain/normalize.ts";
import { rawPair } from "./fixtures/pair.ts";

test("normalizes every requested field from a complete pair", () => {
  const p = normalizePair(rawPair());
  assert.ok(p);
  assert.deepEqual(p, {
    chainId: "solana",
    dexId: "raydium",
    url: "https://dexscreener.com/solana/PAIRaddr1111111111111111111111111111111111",
    pairAddress: "PAIRaddr1111111111111111111111111111111111",
    tokenAddress: "TOKENaddr111111111111111111111111111111pump",
    tokenName: "Test Coin",
    tokenSymbol: "TEST",
    quoteSymbol: "SOL",
    priceUsd: 0.00001234,
    marketCap: 12000,
    fdv: 12340,
    liquidityUsd: 45000.12,
    volumeM5: 1200,
    volumeH1: 15000.25,
    volumeH6: 90000,
    volumeH24: 250000.5,
    buysM5: 12,
    sellsM5: 7,
    buysH1: 140,
    sellsH1: 95,
    priceChangeM5: 1.5,
    priceChangeH1: -3.2,
    priceChangeH6: 12,
    pairCreatedAt: 1758800000000,
  });
});

test("absent fields become null, not zero, and don't throw", () => {
  const p = normalizePair({
    chainId: "solana",
    pairAddress: "P1",
    baseToken: { address: "T1" },
  });
  assert.ok(p);
  assert.equal(p.tokenName, null);
  assert.equal(p.tokenSymbol, null);
  assert.equal(p.priceUsd, null);
  assert.equal(p.marketCap, null);
  assert.equal(p.fdv, null);
  assert.equal(p.liquidityUsd, null);
  assert.equal(p.volumeM5, null);
  assert.equal(p.buysM5, null);
  assert.equal(p.priceChangeH6, null);
  assert.equal(p.pairCreatedAt, null);
  assert.equal(p.dexId, null);
  assert.equal(p.url, null);
});

test("partial nested objects are handled field by field", () => {
  const p = normalizePair(
    rawPair({ liquidity: undefined, txns: { m5: { buys: 3 } }, volume: { h24: 10 }, priceChange: {} }),
  );
  assert.ok(p);
  assert.equal(p.liquidityUsd, null);
  assert.equal(p.buysM5, 3);
  assert.equal(p.sellsM5, null);
  assert.equal(p.buysH1, null);
  assert.equal(p.volumeH24, 10);
  assert.equal(p.volumeM5, null);
  assert.equal(p.priceChangeM5, null);
});

test("wrong types and garbage values become null", () => {
  const p = normalizePair(
    rawPair({
      priceUsd: "not-a-number",
      marketCap: "NaN",
      fdv: null,
      liquidity: { usd: Infinity },
      txns: { m5: { buys: -1, sells: 2.5 }, h1: "x" },
      volume: [],
      pairCreatedAt: 0,
      dexId: "  ",
      baseToken: { address: "T", name: 42, symbol: "" },
    }),
  );
  assert.ok(p);
  assert.equal(p.priceUsd, null);
  assert.equal(p.marketCap, null);
  assert.equal(p.fdv, null);
  assert.equal(p.liquidityUsd, null);
  assert.equal(p.buysM5, null);
  assert.equal(p.sellsM5, null);
  assert.equal(p.buysH1, null);
  assert.equal(p.volumeH1, null);
  assert.equal(p.pairCreatedAt, null);
  assert.equal(p.dexId, null);
  assert.equal(p.tokenName, null);
  assert.equal(p.tokenSymbol, null);
});

test("pairs without pair or base-token address are rejected", () => {
  assert.equal(normalizePair(rawPair({ pairAddress: undefined })), null);
  assert.equal(normalizePair(rawPair({ baseToken: {} })), null);
  assert.equal(normalizePair(null), null);
  assert.equal(normalizePair("x"), null);
  assert.equal(normalizePair([]), null);
});

test("pairCreatedAt in seconds is converted to ms", () => {
  assert.equal(normalizePair(rawPair({ pairCreatedAt: 1758800000 }))?.pairCreatedAt, 1758800000000);
});

test("toNumber parses numeric strings only", () => {
  assert.equal(toNumber("1e-9"), 1e-9);
  assert.equal(toNumber(" 12.5 "), 12.5);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber(true), null);
  assert.equal(toNumber(undefined), null);
});

test("extractPairs accepts both array and {pairs} envelopes", () => {
  assert.equal(extractPairs([1, 2]).length, 2);
  assert.equal(extractPairs({ schemaVersion: "1.0.0", pairs: [1] }).length, 1);
  assert.deepEqual(extractPairs({ schemaVersion: "1.0.0", pairs: null }), []);
  assert.deepEqual(extractPairs("oops"), []);
});

test("extractTokenRefs keeps only well-formed entries", () => {
  const refs = extractTokenRefs([
    { chainId: "solana", tokenAddress: "A", url: "x" },
    { chainId: "base", tokenAddress: "B" },
    { chainId: "solana" },
    null,
    "junk",
  ]);
  assert.deepEqual(refs, [
    { chainId: "solana", tokenAddress: "A" },
    { chainId: "base", tokenAddress: "B" },
  ]);
  assert.deepEqual(extractTokenRefs({ not: "an array" }), []);
});

test("fieldCoverage counts present values", () => {
  const a = normalizePair(rawPair())!;
  const b = normalizePair({ chainId: "solana", pairAddress: "P", baseToken: { address: "T" } })!;
  const cov = fieldCoverage([a, b]);
  assert.equal(cov.priceUsd, 1);
  assert.equal(cov.volumeH24, 1);
});
