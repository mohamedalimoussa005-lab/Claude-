import { test } from "node:test";
import assert from "node:assert/strict";
import { DexScreenerClient, DexScreenerError, retryAfterMs } from "../src/api/dexscreener.ts";
import type { RequestLogEntry } from "../src/api/dexscreener.ts";
import { RateLimiter } from "../src/api/rateLimiter.ts";

function makeClient(responses: (() => Response | Promise<Response>)[], extra: { log?: RequestLogEntry[] } = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let i = 0;
  let now = 0;
  const clock = () => now;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  };
  const client = new DexScreenerClient({
    baseUrl: "https://api.example.test/",
    fetchImpl: (async (url: string | URL | Request) => {
      calls.push(String(url));
      const r = responses[Math.min(i++, responses.length - 1)];
      return r();
    }) as typeof fetch,
    sleep,
    maxRetries: 2,
    timeoutMs: 50,
    onRequest: (e) => extra.log?.push(e),
    limiters: { slow: new RateLimiter(60, 60_000, clock, sleep), fast: new RateLimiter(300, 60_000, clock, sleep) },
  });
  return { client, calls, sleeps };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("builds documented endpoint URLs", async () => {
  const { client, calls } = makeClient([json([])]);
  await client.getLatestTokenProfiles();
  await client.getLatestBoostedTokens();
  await client.getTopBoostedTokens();
  await client.getPairsByTokenAddresses("solana", ["A", "B"]);
  await client.getTokenPools("solana", "A");
  await client.getPairsByPairAddresses("solana", ["P"]);
  await client.searchPairs("bonk sol");
  assert.deepEqual(calls, [
    "https://api.example.test/token-profiles/latest/v1",
    "https://api.example.test/token-boosts/latest/v1",
    "https://api.example.test/token-boosts/top/v1",
    "https://api.example.test/tokens/v1/solana/A,B",
    "https://api.example.test/token-pairs/v1/solana/A",
    "https://api.example.test/latest/dex/pairs/solana/P",
    "https://api.example.test/latest/dex/search?q=bonk%20sol",
  ]);
});

test("rejects batches over 30 addresses", () => {
  const { client } = makeClient([json([])]);
  const many = Array.from({ length: 31 }, (_, i) => `T${i}`);
  assert.throws(() => client.getPairsByTokenAddresses("solana", many), /At most 30/);
});

test("429 honours Retry-After and then succeeds", async () => {
  const log: RequestLogEntry[] = [];
  const { client, calls, sleeps } = makeClient([json({}, 429, { "retry-after": "7" }), json([{ ok: 1 }])], { log });
  const data = await client.getLatestTokenProfiles();
  assert.deepEqual(data, [{ ok: 1 }]);
  assert.equal(calls.length, 2);
  assert.ok(sleeps.includes(7000), `expected a 7000 ms pause, got ${sleeps}`);
  assert.deepEqual(log.map((e) => e.outcome), ["retry", "ok"]);
});

test("persistent 429 surfaces a rate_limit error", async () => {
  const { client, calls } = makeClient([json({}, 429)]);
  await assert.rejects(client.getTopBoostedTokens(), (err: unknown) => {
    assert.ok(err instanceof DexScreenerError);
    assert.equal(err.kind, "rate_limit");
    assert.equal(err.status, 429);
    assert.equal(err.attempts, 3);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("5xx is retried, 4xx is not", async () => {
  const a = makeClient([json({ e: 1 }, 503), json([1])]);
  assert.deepEqual(await a.client.getLatestTokenProfiles(), [1]);
  assert.equal(a.calls.length, 2);

  const b = makeClient([() => new Response("Not found", { status: 404, statusText: "Not Found" })]);
  await assert.rejects(b.client.getTokenPools("solana", "X"), (err: unknown) => {
    assert.ok(err instanceof DexScreenerError);
    assert.equal(err.kind, "http");
    assert.equal(err.status, 404);
    assert.match(err.message, /HTTP 404 Not Found: Not found/);
    return true;
  });
  assert.equal(b.calls.length, 1);
});

test("invalid JSON gives a parse error", async () => {
  const { client } = makeClient([() => new Response("<html>oops</html>", { status: 200 })]);
  await assert.rejects(client.searchPairs("x"), (err: unknown) => err instanceof DexScreenerError && err.kind === "parse");
});

test("network failure is retried then reported", async () => {
  const { client, calls } = makeClient([
    () => {
      throw new TypeError("fetch failed");
    },
  ]);
  await assert.rejects(client.searchPairs("x"), (err: unknown) => {
    assert.ok(err instanceof DexScreenerError);
    assert.equal(err.kind, "network");
    assert.match(err.message, /fetch failed/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("timeout aborts the request", async () => {
  const client = new DexScreenerClient({
    baseUrl: "https://api.example.test",
    timeoutMs: 20,
    maxRetries: 0,
    fetchImpl: ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch,
  });
  await assert.rejects(client.searchPairs("x"), (err: unknown) => err instanceof DexScreenerError && err.kind === "timeout");
});

test("retryAfterMs parses seconds and dates", () => {
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("garbage"), null);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
});
