/** News-first orchestration: news → stories → trend → token matches → DETECTIVE (rapide) on the best candidates. */

import { RadarBudget } from "./budget.ts";
import { clusterStories, dedupeArticles } from "./cluster.ts";
import { NewsCollector, DEFAULT_FEEDS } from "./NewsCollector.ts";
import type { Fetcher, FeedSpec } from "./NewsCollector.ts";
import { SocialEvidenceLedger } from "./SocialEvidenceLedger.ts";
import { TopicToTokenMatcher } from "./TopicToTokenMatcher.ts";
import type { RadarDex } from "./TopicToTokenMatcher.ts";
import { trendFromArticles, trendFromTimeline } from "./TrendDetector.ts";
import type { Match, SourceStatus, Story, StoryResult } from "./types.ts";
import { RADAR_DISCLAIMERS } from "./types.ts";
import type { Finding } from "../types.ts";

export interface DetectiveSummary {
  mint: string;
  mode: string;
  calls: number;
  elapsedMs: number;
  limitsReached: string[];
  status: "done" | "failed" | "skipped";
  reason: string | null;
  findings: Finding[];
  unknowns: string[];
}
export type DetectiveRunner = (mint: string) => Promise<DetectiveSummary>;

export interface RadarOptions {
  feeds?: FeedSpec[];
  maxStories: number;
  minPublishers: number;
  /** Stories for which a GDELT timeline is requested (≥ 5.5 s apart each). */
  gdeltStories: number;
  /** Candidates forwarded to DETECTIVE (0 = none). */
  detectiveTop: number;
  minStrength: number;
  maxRequests: number;
  maxMs: number;
}
export const RADAR_DEFAULTS: RadarOptions = { maxStories: 8, minPublishers: 2, gdeltStories: 2, detectiveTop: 2, minStrength: 3, maxRequests: 60, maxMs: 180_000 };

export interface RadarDeps {
  fetch: Fetcher;
  dex: RadarDex;
  detective?: DetectiveRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Candidate {
  match: Match;
  storyTitle: string;
  detective: DetectiveSummary | null;
}

export interface RadarReport {
  schema: "social-radar-report/1";
  mode: "news-first";
  generatedAt: string;
  sources: SourceStatus[];
  articlesRead: number;
  duplicatesRemoved: number;
  storiesFound: number;
  storiesSkippedSinglePublisher: number;
  stories: StoryResult[];
  candidates: Candidate[];
  budget: { requests: number; maxRequests: number; byHost: Record<string, number>; elapsedMs: number; maxMs: number; limitsReached: string[]; costUsd: 0 };
  gaps: string[];
  ledgerEntries: number;
  disclaimers: string[];
}

export async function runRadar(opts: RadarOptions, deps: RadarDeps): Promise<{ report: RadarReport; ledger: SocialEvidenceLedger }> {
  const now = deps.now ?? Date.now;
  const budget = new RadarBudget(opts.maxRequests, opts.maxMs, now);
  const news = new NewsCollector({ fetch: deps.fetch, budget, sleep: deps.sleep, now });
  const ledger = new SocialEvidenceLedger(now());
  const gaps: string[] = [];

  const raw = await news.collectFeeds(opts.feeds ?? DEFAULT_FEEDS);
  const { articles, duplicates } = dedupeArticles(raw);
  if (articles.length === 0) gaps.push("aucun article lu: toutes les sources d'actualité sont indisponibles ou vides");
  const all = clusterStories(articles);
  const eligible = all.filter((s) => s.distinctPublishers >= opts.minPublishers);
  const stories = eligible.slice(0, opts.maxStories);

  const matcher = new TopicToTokenMatcher({ dex: deps.dex, budget, now });
  const results: StoryResult[] = [];
  let gdeltDone = 0;
  for (const story of stories) {
    let trend = trendFromArticles(story, now());
    if (gdeltDone < opts.gdeltStories && !budget.exhausted && story.phrases[0]) {
      gdeltDone++;
      const tl = trendFromTimeline(await news.gdeltTimeline(story.phrases[0]), now());
      if (tl) trend = tl;
      else if (trend.state === "unknown") trend = { ...trend, reason: `${trend.reason ?? ""}; série GDELT indisponible ou trop courte`.replace(/^; /, "") };
    }
    const { matches, missing } = await matcher.matchStory(story);
    const ids = story.articles.slice(0, 5).map((a) => ledger.article(a));
    for (const m of matches) ledger.match(story, m, ids);
    results.push({ story, trend, matches, missing });
  }
  gaps.push(...matcher.notes);

  // forward the best candidates to DETECTIVE (quick mode), one run per distinct token
  const seen = new Set<string>();
  const ranked = results
    .flatMap((r) => r.matches.filter((m) => m.strength >= opts.minStrength).map((m) => ({ m, story: r.story.title })))
    .sort((a, b) => b.m.strength - a.m.strength || (b.m.liquidityUsd ?? 0) - (a.m.liquidityUsd ?? 0))
    .filter((c) => (seen.has(c.m.mint) ? false : (seen.add(c.m.mint), true)));
  const candidates: Candidate[] = [];
  for (const c of ranked.slice(0, Math.max(opts.detectiveTop, 0))) {
    let d: DetectiveSummary | null = null;
    if (deps.detective) {
      try {
        d = await deps.detective(c.m.mint);
      } catch (e) {
        d = { mint: c.m.mint, mode: "rapide", calls: 0, elapsedMs: 0, limitsReached: [], status: "failed", reason: e instanceof Error ? e.message : String(e), findings: [], unknowns: [] };
      }
    }
    candidates.push({ match: c.m, storyTitle: c.story, detective: d });
  }
  if (ranked.length === 0) gaps.push(results.length ? `aucun token candidat de force ≥ ${opts.minStrength} parmi ${results.length} sujet(s)` : "aucun sujet à analyser");

  const xStatus: SourceStatus = { source: "x", state: "not_used", requests: 0, articles: 0, newestAt: null, reason: "API officielle payante non utilisée; scraping exclu" };
  const sources = [...mergeStatuses(news.statuses), xStatus];
  ledger.gaps(sources, gaps);
  const report: RadarReport = {
    schema: "social-radar-report/1",
    mode: "news-first",
    generatedAt: new Date(now()).toISOString(),
    sources,
    articlesRead: raw.length,
    duplicatesRemoved: duplicates,
    storiesFound: all.length,
    storiesSkippedSinglePublisher: all.length - eligible.length,
    stories: results,
    candidates,
    budget: { requests: budget.requests, maxRequests: budget.maxRequests, byHost: { ...budget.byHost }, elapsedMs: budget.elapsedMs, maxMs: budget.maxMs, limitsReached: [...budget.limitsReached], costUsd: 0 },
    gaps,
    ledgerEntries: ledger.ledger.all().length,
    disclaimers: [...RADAR_DISCLAIMERS],
  };
  return { report, ledger };
}

/** One row per source (several requests to the same source are merged). */
function mergeStatuses(list: SourceStatus[]): SourceStatus[] {
  const rank = { ok: 0, partial: 1, unavailable: 2, not_used: 3 } as const;
  const by = new Map<string, SourceStatus>();
  for (const s of list) {
    const p = by.get(s.source);
    if (!p) by.set(s.source, { ...s });
    else {
      p.requests += s.requests;
      p.articles += s.articles;
      p.newestAt = Math.max(p.newestAt ?? 0, s.newestAt ?? 0) || null;
      if (rank[s.state] > rank[p.state] && p.articles === 0) p.state = s.state;
      else if (rank[s.state] > 0 && p.state === "ok") p.state = "partial";
      p.reason = [p.reason, s.reason].filter(Boolean).join(" ; ") || null;
    }
  }
  return [...by.values()];
}

export type { Story };
