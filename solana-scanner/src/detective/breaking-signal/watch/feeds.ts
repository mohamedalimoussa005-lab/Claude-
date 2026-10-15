/**
 * Free, legally reachable feeds for the watch loop, and a polite client: one request per feed per due time, ETag /
 * If-Modified-Since, exponential back-off after errors and on 429. Feeds that were unreachable when checked are NOT listed
 * (whitehouse.gov/feed 404, tmtgcorp 403, globenewswire 403). No X, no Truth Social, no scraping.
 */

import { parseFeed } from "../../social-radar/NewsCollector.ts";
import type { Article } from "../../social-radar/types.ts";

export type FeedClass = "official" | "wire" | "press" | "aggregator";

export interface WatchFeed {
  id: string;
  url: string;
  class: FeedClass;
  kind: "rss" | "google";
  /** Minimum time between two requests to this feed (ms). */
  minIntervalMs: number;
}

const GN = "hl=en-US&gl=US&ceid=US:en";
const gnSearch = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${GN}`;

/** Checked reachable on 2026-10-14 from the sandbox (HTTP 200 with items). */
export const WATCH_FEEDS: WatchFeed[] = [
  { id: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss", class: "press", kind: "rss", minIntervalMs: 60_000 },
  { id: "cointelegraph", url: "https://cointelegraph.com/rss", class: "press", kind: "rss", minIntervalMs: 60_000 },
  { id: "decrypt", url: "https://decrypt.co/feed", class: "press", kind: "rss", minIntervalMs: 60_000 },
  { id: "theblock", url: "https://www.theblock.co/rss.xml", class: "press", kind: "rss", minIntervalMs: 60_000 },
  { id: "cryptoslate", url: "https://cryptoslate.com/feed/", class: "press", kind: "rss", minIntervalMs: 120_000 },
  { id: "bitcoinmagazine", url: "https://bitcoinmagazine.com/feed", class: "press", kind: "rss", minIntervalMs: 120_000 },
  { id: "solana-news", url: "https://solana.com/news/rss.xml", class: "official", kind: "rss", minIntervalMs: 120_000 },
  { id: "prnewswire", url: "https://www.prnewswire.com/rss/news-releases-list.rss", class: "wire", kind: "rss", minIntervalMs: 120_000 },
  { id: "gnews:trump-memecoin", url: gnSearch("trump memecoin OR \"trump meme coin\" OR \"trump token\" when:1d"), class: "aggregator", kind: "google", minIntervalMs: 120_000 },
  { id: "gnews:memecoin-launch", url: gnSearch("memecoin launch solana OR \"launches memecoin\" OR \"new meme coin\" when:1d"), class: "aggregator", kind: "google", minIntervalMs: 120_000 },
];

export interface FeedResponse {
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}
export type FeedFetcher = (url: string, init: { signal?: AbortSignal; headers: Record<string, string> }) => Promise<FeedResponse>;

export type FeedState = "ok" | "unchanged" | "not_due" | "error" | "backoff";
export interface FeedStatus {
  id: string;
  state: FeedState;
  items: number;
  consecutiveFailures: number;
  reason: string | null;
  /** Newest item time (ms) seen in this fetch — freshness of the source. */
  newestAt: number | null;
}

interface Poll {
  nextAt: number;
  etag: string | null;
  lastModified: string | null;
  failures: number;
}

export class PoliteFeedClient {
  private readonly polls = new Map<string, Poll>();
  private readonly fetchImpl: FeedFetcher;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  requests = 0;
  constructor(fetchImpl: FeedFetcher, now: () => number = Date.now, timeoutMs = 12_000) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async fetchDue(feeds: WatchFeed[], intervalMs: number): Promise<{ articles: Article[]; statuses: FeedStatus[] }> {
    const articles: Article[] = [];
    const statuses: FeedStatus[] = [];
    for (const f of feeds) {
      const p = this.polls.get(f.id) ?? { nextAt: 0, etag: null, lastModified: null, failures: 0 };
      this.polls.set(f.id, p);
      const t = this.now();
      if (t + 2000 < p.nextAt) { // 2 s tolerance: a cycle that starts a hair early is not a new burst of requests
        statuses.push({ id: f.id, state: p.failures > 0 ? "backoff" : "not_due", items: 0, consecutiveFailures: p.failures, reason: p.failures > 0 ? `nouvelle tentative dans ${Math.ceil((p.nextAt - t) / 1000)} s (reprise après erreur)` : null, newestAt: null });
        continue;
      }
      const headers: Record<string, string> = { "User-Agent": "detective-breaking-signal/1 (read-only; personal use)", Accept: "application/rss+xml, application/xml, text/xml, */*" };
      if (p.etag) headers["If-None-Match"] = p.etag;
      if (p.lastModified) headers["If-Modified-Since"] = p.lastModified;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      this.requests++;
      try {
        const r = await this.fetchImpl(f.url, { signal: ctl.signal, headers });
        if (r.status === 304) {
          p.failures = 0;
          p.nextAt = t + Math.max(f.minIntervalMs, intervalMs);
          statuses.push({ id: f.id, state: "unchanged", items: 0, consecutiveFailures: 0, reason: null, newestAt: null });
          continue;
        }
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const items = parseFeed(await r.text(), f.id, f.kind);
        p.etag = r.headers?.get("etag") ?? null;
        p.lastModified = r.headers?.get("last-modified") ?? null;
        p.failures = 0;
        p.nextAt = t + Math.max(f.minIntervalMs, intervalMs);
        articles.push(...items);
        statuses.push({ id: f.id, state: items.length ? "ok" : "error", items: items.length, consecutiveFailures: items.length ? 0 : 1, reason: items.length ? null : "flux lu mais aucun article exploitable", newestAt: items.reduce<number | null>((m, a) => (a.publishedAt !== null && (m === null || a.publishedAt > m) ? a.publishedAt : m), null) });
      } catch (e) {
        p.failures++;
        const back = Math.min(15 * 60_000, Math.max(f.minIntervalMs, intervalMs) * 2 ** Math.min(p.failures, 5));
        p.nextAt = t + back;
        statuses.push({ id: f.id, state: "error", items: 0, consecutiveFailures: p.failures, reason: e instanceof Error && e.name === "AbortError" ? "délai dépassé" : e instanceof Error ? e.message : String(e), newestAt: null });
      } finally {
        clearTimeout(timer);
      }
    }
    return { articles, statuses };
  }
}
