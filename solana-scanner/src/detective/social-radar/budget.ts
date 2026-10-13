/** Request and time budget of the radar. Free sources only: cost is always 0 and is stated in the report. */

export class RadarBudget {
  requests = 0;
  readonly byHost: Record<string, number> = {};
  readonly limitsReached: string[] = [];
  readonly maxRequests: number;
  readonly maxMs: number;
  private readonly now: () => number;
  private readonly t0: number;
  constructor(maxRequests: number, maxMs: number, now: () => number = Date.now) {
    this.maxRequests = maxRequests;
    this.maxMs = maxMs;
    this.now = now;
    this.t0 = now();
  }
  get elapsedMs(): number {
    return this.now() - this.t0;
  }
  get exhausted(): boolean {
    return this.requests >= this.maxRequests || this.elapsedMs > this.maxMs;
  }
  /** Returns false (and records the limit) when the budget does not allow one more request. */
  take(host: string): boolean {
    if (this.requests >= this.maxRequests) return this.limit(`budget de requêtes atteint (${this.maxRequests})`);
    if (this.elapsedMs > this.maxMs) return this.limit(`budget de temps atteint (${Math.round(this.maxMs / 1000)} s)`);
    this.requests++;
    this.byHost[host] = (this.byHost[host] ?? 0) + 1;
    return true;
  }
  limit(text: string): false {
    if (!this.limitsReached.includes(text)) this.limitsReached.push(text);
    return false;
  }
}
