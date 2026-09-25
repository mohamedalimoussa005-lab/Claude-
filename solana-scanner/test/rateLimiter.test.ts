import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/api/rateLimiter.ts";

/** Virtual clock: sleep() advances time instantly. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

test("grants up to max requests per window, then waits for the window to slide", async () => {
  const t = fakeTime();
  const limiter = new RateLimiter(3, 1000, t.now, t.sleep);
  const grantedAt: number[] = [];
  for (let i = 0; i < 7; i++) {
    await limiter.acquire();
    grantedAt.push(t.now());
  }
  assert.deepEqual(grantedAt.slice(0, 3), [0, 0, 0]);
  // 4th must wait until the first stamp leaves the window.
  assert.ok(grantedAt[3] >= 1000);
  // Never more than 3 grants in any 1000 ms window.
  for (let i = 3; i < grantedAt.length; i++) assert.ok(grantedAt[i] - grantedAt[i - 3] >= 1000);
});

test("concurrent callers are served in order and never exceed the limit", async () => {
  const t = fakeTime();
  const limiter = new RateLimiter(2, 500, t.now, t.sleep);
  const order: number[] = [];
  const times: number[] = [];
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      limiter.acquire().then(() => {
        order.push(i);
        times.push(t.now());
      }),
    ),
  );
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  for (let i = 2; i < times.length; i++) assert.ok(times[i] - times[i - 2] >= 500);
});

test("pauseFor blocks every caller", async () => {
  const t = fakeTime();
  const limiter = new RateLimiter(100, 1000, t.now, t.sleep);
  await limiter.acquire();
  limiter.pauseFor(5000);
  await limiter.acquire();
  assert.ok(t.now() >= 5000);
});
