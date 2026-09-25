/**
 * Live check against the real DEX Screener API.
 *
 *   npm run test:live
 *
 * Calls every endpoint the scanner relies on (plus the other public pair
 * endpoints), checks the response shape, reports how often each requested
 * field is present, prints sample rows, then runs the full scan pipeline.
 * Exits with code 1 if any check fails.
 */

import { DexScreenerClient, DexScreenerError } from "../src/api/dexscreener.ts";
import type { RequestLogEntry } from "../src/api/dexscreener.ts";
import { METRIC_FIELDS, SOURCE_PATH, extractPairs, extractTokenRefs, fieldCoverage, normalizePair } from "../src/domain/normalize.ts";
import type { NormalizedPair } from "../src/domain/normalize.ts";
import { SOLANA, scanSolana } from "../src/domain/scanner.ts";

const log: RequestLogEntry[] = [];
const client = new DexScreenerClient({
  baseUrl: process.env.DEXSCREENER_BASE_URL,
  onRequest: (e) => log.push(e),
});

let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✘ ${msg}`);
};
const check = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));

async function step<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  console.log(`\n▶ ${title}`);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DexScreenerError) {
      fail(`${err.kind}${err.status ? ` HTTP ${err.status}` : ""} on ${err.endpoint}: ${err.message}`);
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
    return undefined;
  }
}

function checkDiscoveryFeed(name: string, data: unknown): string[] {
  check(Array.isArray(data), `${name}: response is an array`);
  const refs = extractTokenRefs(data);
  const total = Array.isArray(data) ? data.length : 0;
  const sol = refs.filter((r) => r.chainId === SOLANA);
  check(refs.length > 0, `${name}: ${refs.length}/${total} entries have chainId + tokenAddress`);
  ok(`${name}: ${sol.length} Solana tokens (chains seen: ${[...new Set(refs.map((r) => r.chainId))].join(", ")})`);
  return sol.map((r) => r.tokenAddress);
}

function checkPairs(name: string, raw: unknown[]): NormalizedPair[] {
  const pairs = raw.map(normalizePair).filter((p): p is NormalizedPair => p !== null);
  check(raw.length > 0, `${name}: ${raw.length} raw pairs returned`);
  check(pairs.length === raw.length, `${name}: ${pairs.length}/${raw.length} pairs normalised (have pairAddress + baseToken.address)`);
  return pairs;
}

function printCoverage(pairs: NormalizedPair[]) {
  const cov = fieldCoverage(pairs);
  console.log(`\n  Field coverage over ${pairs.length} pairs:`);
  for (const f of METRIC_FIELDS) {
    const pct = pairs.length ? Math.round((cov[f] / pairs.length) * 100) : 0;
    console.log(`    ${SOURCE_PATH[f].padEnd(18)} ${String(cov[f]).padStart(4)} / ${pairs.length}  (${pct}%)`);
  }
}

function printSample(pairs: NormalizedPair[], n = 10) {
  const rows = pairs.slice(0, n).map((p) => ({
    symbol: p.tokenSymbol,
    token: p.tokenAddress.slice(0, 8),
    pair: p.pairAddress.slice(0, 8),
    dex: p.dexId,
    priceUsd: p.priceUsd,
    mcap: p.marketCap,
    liq: p.liquidityUsd,
    vol1h: p.volumeH1,
    "b/s 5m": `${p.buysM5 ?? "-"}/${p.sellsM5 ?? "-"}`,
    "Δ1h": p.priceChangeH1,
    created: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString().slice(0, 16) : null,
  }));
  console.table(rows);
}

async function main() {
  console.log(`DEX Screener live test — ${new Date().toISOString()}`);
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
    console.log("note: HTTPS_PROXY is set; Node's fetch ignores it unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).");
  }

  const solTokens = new Set<string>();

  const profiles = await step("GET /token-profiles/latest/v1", () => client.getLatestTokenProfiles());
  if (profiles !== undefined) checkDiscoveryFeed("profiles", profiles).forEach((t) => solTokens.add(t));

  const boostsLatest = await step("GET /token-boosts/latest/v1", () => client.getLatestBoostedTokens());
  if (boostsLatest !== undefined) checkDiscoveryFeed("boosts latest", boostsLatest).forEach((t) => solTokens.add(t));

  const boostsTop = await step("GET /token-boosts/top/v1", () => client.getTopBoostedTokens());
  if (boostsTop !== undefined) checkDiscoveryFeed("boosts top", boostsTop).forEach((t) => solTokens.add(t));

  const tokens = [...solTokens].slice(0, 30);
  let batchPairs: NormalizedPair[] = [];
  if (tokens.length > 0) {
    const data = await step(`GET /tokens/v1/solana/{${tokens.length} addresses}`, () =>
      client.getPairsByTokenAddresses(SOLANA, tokens),
    );
    if (data !== undefined) {
      check(Array.isArray(data), "tokens/v1: response is an array");
      batchPairs = checkPairs("tokens/v1", extractPairs(data));
      check(batchPairs.every((p) => p.chainId === SOLANA), "tokens/v1: all pairs are on Solana");
    }
  } else {
    fail("no Solana token discovered, cannot test /tokens/v1");
  }

  const firstToken = batchPairs[0]?.tokenAddress ?? tokens[0];
  if (firstToken) {
    const data = await step(`GET /token-pairs/v1/solana/${firstToken}`, () => client.getTokenPools(SOLANA, firstToken));
    if (data !== undefined) {
      check(Array.isArray(data), "token-pairs/v1: response is an array");
      checkPairs("token-pairs/v1", extractPairs(data));
    }
  }

  const firstPair = batchPairs[0]?.pairAddress;
  if (firstPair) {
    const data = await step(`GET /latest/dex/pairs/solana/${firstPair}`, () =>
      client.getPairsByPairAddresses(SOLANA, [firstPair]),
    );
    if (data !== undefined) {
      const pairs = checkPairs("latest/dex/pairs", extractPairs(data));
      check(pairs[0]?.pairAddress === firstPair, "latest/dex/pairs: returns the requested pair");
    }
  }

  const search = await step("GET /latest/dex/search?q=SOL", () => client.searchPairs("SOL"));
  if (search !== undefined) {
    const pairs = checkPairs("search", extractPairs(search));
    ok(`search: ${pairs.filter((p) => p.chainId === SOLANA).length} Solana pairs`);
  }

  const scan = await step("Full pipeline scanSolana()", () => scanSolana(client));
  if (scan) {
    const s = scan.stats;
    ok(
      `discovered profiles=${s.discoveredBySource.profiles} boosts-latest=${s.discoveredBySource["boosts-latest"]} boosts-top=${s.discoveredBySource["boosts-top"]} → ${s.uniqueSolanaTokens} unique Solana tokens`,
    );
    ok(
      `${s.pairRequests} /tokens/v1 calls → ${s.rawPairs} raw pairs → ${s.keptPairs} kept (quote-side ${s.skippedQuoteSide}, other chain ${s.skippedOtherChain}, invalid ${s.skippedInvalid}, dup ${s.skippedDuplicate}); ${s.tokensWithoutPairs} tokens without pairs; ${scan.durationMs} ms`,
    );
    check(scan.errors.length === 0, `scan errors: ${scan.errors.length}`);
    for (const e of scan.errors) console.log(`    - [${e.stage}/${e.source}/${e.kind}] ${e.message}`);
    check(scan.pairs.length > 0, "scan returned pairs");
    printCoverage(scan.pairs);
    const byVolume = [...scan.pairs].sort((a, b) => (b.volumeH1 ?? -1) - (a.volumeH1 ?? -1));
    console.log("\n  Top 10 pairs by 1h volume:");
    printSample(byVolume);
  }

  const retries = log.filter((e) => e.outcome === "retry").length;
  const rateLimited = log.filter((e) => e.status === 429).length;
  console.log(`\nRequests: ${log.length} total, ${retries} retries, ${rateLimited} HTTP 429.`);
  console.log(failures === 0 ? "\nRESULT: all live checks passed." : `\nRESULT: ${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
