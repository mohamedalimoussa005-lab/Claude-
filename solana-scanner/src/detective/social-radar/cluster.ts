/** Deduplication of articles and grouping into stories (one event = one story). */

import { canonicalUrl } from "./NewsCollector.ts";
import { extractPhrases, findAddresses, hash, jaccard, keywordsOf, stanceOf } from "./text.ts";
import type { Article, Story } from "./types.ts";

/** Drops the same article seen twice (same URL, or same publisher + same normalized title). */
export function dedupeArticles(articles: Article[]): { articles: Article[]; duplicates: number } {
  const seenUrl = new Set<string>();
  const seenId = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    const u = canonicalUrl(a.url);
    if (seenUrl.has(u) || seenId.has(a.id)) continue;
    seenUrl.add(u);
    seenId.add(a.id);
    out.push(a);
  }
  return { articles: out, duplicates: articles.length - out.length };
}

export interface ClusterOptions {
  /** Title keyword Jaccard needed to link two articles. */
  minSimilarity: number;
}
export const DEFAULT_CLUSTER: ClusterOptions = { minSimilarity: 0.45 };

export function clusterStories(articles: Article[], opts: ClusterOptions = DEFAULT_CLUSTER): Story[] {
  const n = articles.length;
  const kw = articles.map((a) => new Set(keywordsOf(a.title)));
  const ph = articles.map((a) => new Set(extractPhrases(a.title).phrases.filter((p) => p.length >= 5)));
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sharedPhrases = [...ph[i]!].filter((p) => ph[j]!.has(p)).length;
      if (jaccard(kw[i]!, kw[j]!) >= opts.minSimilarity || (sharedPhrases >= 2 && jaccard(kw[i]!, kw[j]!) >= 0.25)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Article[]>();
  articles.forEach((a, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), a]));
  return [...groups.values()].map(toStory).sort((a, b) => b.distinctPublishers - a.distinctPublishers || (b.newestAt ?? 0) - (a.newestAt ?? 0));
}

function toStory(arts: Article[]): Story {
  const sorted = [...arts].sort((a, b) => (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity));
  const times = arts.map((a) => a.publishedAt).filter((t): t is number => t !== null);
  const stance = { confirm: 0, deny: 0, neutral: 0 };
  for (const a of arts) stance[stanceOf(`${a.title} ${a.summary}`)]++;
  const phraseCount = new Map<string, number>();
  const tickers = new Set<string>();
  const addresses = new Set<string>();
  const kwCount = new Map<string, number>();
  for (const a of arts) {
    const e = extractPhrases(a.title);
    for (const p of new Set(e.phrases)) phraseCount.set(p, (phraseCount.get(p) ?? 0) + 1);
    e.tickers.forEach((t) => tickers.add(t));
    findAddresses(`${a.title} ${a.summary}`).forEach((x) => addresses.add(x));
    for (const k of new Set(keywordsOf(a.title))) kwCount.set(k, (kwCount.get(k) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, k: number) => [...m.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length).slice(0, k).map(([w]) => w);
  const first = sorted[0]!;
  return {
    id: hash(first.id + arts.length),
    title: first.title,
    articles: sorted,
    distinctPublishers: new Set(arts.map((a) => a.publisher.toLowerCase())).size,
    firstSeenAt: times.length ? Math.min(...times) : null,
    newestAt: times.length ? Math.max(...times) : null,
    disputed: stance.deny > 0 && stance.confirm > 0,
    stance,
    keywords: top(kwCount, 8),
    phrases: top(phraseCount, 6),
    addresses: [...addresses],
    tickers: [...tickers],
  };
}
