/**
 * Sliding-window rate limiter.
 *
 * Callers `await acquire()` before each request. At most `maxRequests`
 * acquisitions are granted in any rolling `windowMs` window; further callers
 * wait (FIFO) until a slot frees up. `pauseFor()` blocks every caller for a
 * while, used when the server answers 429.
 */

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  private readonly now: Clock;
  private readonly sleep: Sleep;
  private stamps: number[] = [];
  private blockedUntil = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(maxRequests: number, windowMs: number, now: Clock = Date.now, sleep: Sleep = realSleep) {
    if (maxRequests < 1) throw new Error("maxRequests must be >= 1");
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
  }

  /** Resolves when the caller may send one request. Calls are served in order. */
  acquire(): Promise<void> {
    const turn = this.tail.then(() => this.waitForSlot());
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /** Blocks all callers for `ms` from now (e.g. after an HTTP 429). */
  pauseFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** Requests granted within the current window. */
  inFlightWindowCount(): number {
    this.evict(this.now());
    return this.stamps.length;
  }

  private evict(t: number): void {
    while (this.stamps.length > 0 && t - this.stamps[0] >= this.windowMs) this.stamps.shift();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const t = this.now();
      if (t < this.blockedUntil) {
        await this.sleep(this.blockedUntil - t);
        continue;
      }
      this.evict(t);
      if (this.stamps.length < this.maxRequests) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(this.windowMs - (t - this.stamps[0]) + 1);
    }
  }
}
