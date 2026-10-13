/**
 * Free news sources: public RSS/Atom feeds, Google News RSS and the GDELT DOC 2.0 API.
 * Every source returns a status; an unavailable source is UNKNOWN, never "no news". No X post is read here.
 */

import { RadarBudget } from "./budget.ts";
import { decodeEntities, hash, norm, stripTags } from "./text.ts";
import type { Article, SourceStatus } from "./types.ts";

export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

export interface FeedSpec {
  id: string;
  url: string;
  kind: "rss" | "google";
}

const GN = "hl=en-US&gl=US&ceid=US:en";
/** Public feeds checked reachable on 2026-10-13. Google News and BBC feeds are for personal, non-commercial reading. */
export const DEFAULT_FEEDS: FeedSpec[] = [
  { id: "google-news:top", url: `https://news.google.com/rss?${GN}`, kind: "google" },
  { id: "google-news:technology", url: `https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?${GN}`, kind: "google" },
  { id: "google-news:entertainment", url: `https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?${GN}`, kind: "google" },
  { id: "bbc:world", url: "https://feeds.bbci.co.uk/news/world/rss.xml", kind: "rss" },
  { id: "cointelegraph", url: "https://cointelegraph.com/rss", kind: "rss" },
];

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? stripTags(m[1]!) : null;
};

export function canonicalUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|oc$|ocid$|cmpid$|ref$|fbclid$|gclid$)/i.test(k)) x.searchParams.delete(k);
    return x.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** RSS 2.0 and Atom, tolerant (CDATA, entities, missing fields). Items without a title are dropped. */
export function parseFeed(xml: string, feed: string, kind: "rss" | "google" = "rss"): Article[] {
  const out: Article[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!);
  const channel = tag(xml.replace(/<(item|entry)[\s\S]*$/i, ""), "title") ?? feed;
  for (const b of blocks) {
    const rawTitle = tag(b, "title");
    if (!rawTitle) continue;
    let url = tag(b, "link") ?? "";
    if (!url) url = decodeEntities(b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "");
    let title = rawTitle;
    let publisher = tag(b, "source") ?? "";
    if (kind === "google" || publisher) {
      // "Headline - Publisher": the publisher is the dedup-relevant part, not the title
      const m = title.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
      if (m) {
        if (!publisher) publisher = m[2]!.trim();
        if (publisher && m[2]!.trim() === publisher) title = m[1]!;
      }
    }
    if (!publisher) {
      try {
        publisher = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        publisher = channel;
      }
    }
    const date = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const summary = (tag(b, "description") ?? tag(b, "summary") ?? "").slice(0, 400);
    out.push({ id: hash(`${norm(publisher)}|${norm(title)}`), title, norm: norm(title), url: canonicalUrl(url), publisher, feed, publishedAt: parseDate(date), summary });
  }
  return out;
}

/** GDELT "seendate": 20261013T185700Z */
export function parseGdeltDate(s: unknown): number | null {
  const m = typeof s === "string" ? s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/) : null;
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

export function parseGdeltArticles(json: unknown, feed = "gdelt:artlist"): Article[] {
  const arr = (json as { articles?: unknown })?.articles;
  if (!Array.isArray(arr)) return [];
  const out: Article[] = [];
  for (const a of arr as Record<string, unknown>[]) {
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const url = typeof a.url === "string" ? a.url : "";
    if (!title || !url) continue;
    const publisher = typeof a.domain === "string" && a.domain ? a.domain : new URL(url).hostname.replace(/^www\./, "");
    out.push({ id: hash(`${norm(publisher)}|${norm(title)}`), title, norm: norm(title), url: canonicalUrl(url), publisher, feed, publishedAt: parseGdeltDate(a.seendate), summary: "" });
  }
  return out;
}

export interface TimelinePoint {
  t: number;
  v: number;
}
export function parseGdeltTimeline(json: unknown): TimelinePoint[] {
  const data = (json as { timeline?: { data?: unknown }[] })?.timeline?.[0]?.data;
  if (!Array.isArray(data)) return [];
  return (data as { date?: unknown; value?: unknown }[]).flatMap((p) => {
    const t = parseGdeltDate(p.date);
    return t !== null && typeof p.value === "number" ? [{ t, v: p.value }] : [];
  });
}

export interface CollectorDeps {
  fetch: Fetcher;
  budget: RadarBudget;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hostOf = (u: string) => new URL(u).hostname;

async function get(d: CollectorDeps, url: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const host = hostOf(url);
  if (!d.budget.take(host)) return { ok: false, reason: d.budget.limitsReached[d.budget.limitsReached.length - 1] ?? "budget épuisé" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), d.timeoutMs ?? 15_000);
  try {
    const r = await d.fetch(url, { signal: ctl.signal, headers: { "User-Agent": "detective-social-radar/1 (read-only; personal use)", Accept: "application/xml, application/json, text/xml, */*" } });
    if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
    return { ok: true, text: await r.text() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === "AbortError" ? "délai dépassé" : `erreur réseau (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    clearTimeout(timer);
  }
}

export class NewsCollector {
  readonly statuses: SourceStatus[] = [];
  private lastGdeltAt = 0;
  private readonly d: CollectorDeps;
  constructor(d: CollectorDeps) {
    this.d = d;
  }
  private status(source: string, over: Partial<SourceStatus>): SourceStatus {
    const s: SourceStatus = { source, state: "unavailable", requests: 0, articles: 0, newestAt: null, reason: null, ...over };
    this.statuses.push(s);
    return s;
  }

  async collectFeeds(feeds: FeedSpec[] = DEFAULT_FEEDS): Promise<Article[]> {
    const all: Article[] = [];
    for (const f of feeds) {
      const r = await get(this.d, f.url);
      if (!r.ok) {
        this.status(f.id, { requests: r.reason.startsWith("budget") ? 0 : 1, reason: r.reason });
        continue;
      }
      const arts = parseFeed(r.text, f.id, f.kind);
      this.status(f.id, { state: arts.length ? "ok" : "partial", requests: 1, articles: arts.length, newestAt: arts.reduce<number | null>((m, a) => (a.publishedAt !== null && (m === null || a.publishedAt > m) ? a.publishedAt : m), null), reason: arts.length ? null : "flux lu mais aucun article exploitable" });
      all.push(...arts);
    }
    return all;
  }

  /** Google News RSS search for a phrase (used to measure a story's coverage, not to find tokens). */
  async searchGoogle(query: string, whenDays = 2): Promise<Article[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${whenDays}d`)}&hl=en-US&gl=US&ceid=US:en`;
    const r = await get(this.d, url);
    const id = `google-news:search`;
    if (!r.ok) {
      this.status(id, { requests: r.reason.startsWith("budget") ? 0 : 1, reason: `${query}: ${r.reason}` });
      return [];
    }
    const arts = parseFeed(r.text, id, "google");
    this.status(id, { state: arts.length ? "ok" : "partial", requests: 1, articles: arts.length, reason: arts.length ? null : `${query}: aucun résultat` });
    return arts;
  }

  private async gdeltGate(): Promise<void> {
    const wait = this.lastGdeltAt + 5500 - (this.d.now ?? Date.now)();
    if (this.lastGdeltAt && wait > 0) await (this.d.sleep ?? realSleep)(wait);
    this.lastGdeltAt = (this.d.now ?? Date.now)();
  }

  /** GDELT volume-intensity timeline of a phrase (free, ≥ 5 s between requests). null = unavailable. */
  async gdeltTimeline(phrase: string, span = "3d"): Promise<TimelinePoint[] | null> {
    await this.gdeltGate();
    const q = `"${phrase.replace(/"/g, "")}" sourcelang:english`;
    const r = await get(this.d, `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=timelinevol&format=json&timespan=${span}`);
    const id = "gdelt:timeline";
    if (!r.ok) {
      this.status(id, { requests: r.reason.startsWith("budget") ? 0 : 1, reason: `${phrase}: ${r.reason}` });
      return null;
    }
    try {
      const pts = parseGdeltTimeline(JSON.parse(r.text));
      this.status(id, { state: pts.length ? "ok" : "partial", requests: 1, articles: pts.length, newestAt: pts.length ? pts[pts.length - 1]!.t : null, reason: pts.length ? null : `${phrase}: série vide` });
      return pts.length ? pts : null;
    } catch {
      this.status(id, { requests: 1, reason: `${phrase}: réponse non JSON (limite de débit probable)` });
      return null;
    }
  }

  async gdeltArticles(query: string, timespan = "6h", max = 50): Promise<Article[]> {
    await this.gdeltGate();
    const r = await get(this.d, `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${query} sourcelang:english`)}&mode=artlist&format=json&maxrecords=${max}&sort=datedesc&timespan=${timespan}`);
    const id = "gdelt:artlist";
    if (!r.ok) {
      this.status(id, { requests: r.reason.startsWith("budget") ? 0 : 1, reason: r.reason });
      return [];
    }
    try {
      const arts = parseGdeltArticles(JSON.parse(r.text), id);
      this.status(id, { state: arts.length ? "ok" : "partial", requests: 1, articles: arts.length, reason: arts.length ? null : "aucun article" });
      return arts;
    } catch {
      this.status(id, { requests: 1, reason: "réponse non JSON (limite de débit probable)" });
      return [];
    }
  }
}
