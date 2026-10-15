/**
 * Watch loop: poll free feeds, keep only NEW and RELEVANT articles, group them into stories, verify, and alert once per
 * story (plus at most one upgrade per higher level). Alert 1 goes out before any enquiry; the enquiry runs after, queued.
 * Every delay is measured; an unreadable source is reported as unknown, never as "nothing happened".
 */

import { clusterStories, dedupeArticles } from "../../social-radar/cluster.ts";
import type { Article } from "../../social-radar/types.ts";
import type { Notifier } from "../notify.ts";
import type { DetectiveBrief, Homonym, OnchainQuick } from "../types.ts";
import { PoliteFeedClient, WATCH_FEEDS } from "./feeds.ts";
import type { FeedFetcher, FeedStatus, WatchFeed } from "./feeds.ts";
import { DEFAULT_TERMS, scoreArticle } from "./relevance.ts";
import type { WatchTerms } from "./relevance.ts";
import { sendFirstAlert } from "./signal.ts";
import type { NewsSignal, SignalResult } from "./signal.ts";
import { StateStore } from "./state.ts";
import { RANK, verifyNews } from "./verifyNews.ts";
import type { NewsVerification } from "./verifyNews.ts";

export interface WatchConfig {
  intervalMs: number;
  /** Articles older than this at first reading are ignored (avoids reacting to old news). */
  maxAgeMs: number;
  maxAlertsPerHour: number;
  baseline: boolean;
  fastCheckMs: number;
  /** Consecutive ticks with at least half of the sources failing before a "degraded" notice. */
  degradedAfter: number;
  terms: WatchTerms;
  feeds: WatchFeed[];
}

export const DEFAULT_WATCH: WatchConfig = { intervalMs: 60_000, maxAgeMs: 3 * 3_600_000, maxAlertsPerHour: 10, baseline: true, fastCheckMs: 6000, degradedAfter: 5, terms: DEFAULT_TERMS, feeds: WATCH_FEEDS };

export interface WatchDeps {
  fetch: FeedFetcher;
  notifier: Notifier;
  store: StateStore;
  now?: () => number;
  provenance?: "rss" | "simulation";
  checkMint?: (mint: string) => Promise<OnchainQuick | null>;
  findHomonyms?: (names: string[], exclude: string | null) => Promise<Homonym[]>;
  detective?: (mint: string) => Promise<DetectiveBrief>;
  log?: (line: string) => void;
  eventLog?: (e: Record<string, unknown>) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface IgnoredItem {
  title: string;
  reason: string;
}

export interface TickResult {
  at: number;
  baseline: boolean;
  statuses: FeedStatus[];
  fetched: number;
  newArticles: number;
  relevantNew: number;
  alerts: SignalResult[];
  ignored: IgnoredItem[];
  suppressed: string[];
  degraded: boolean;
  /** True when no source could be read at all: the absence of alert then says nothing about the world. */
  blind: boolean;
}

export class Watcher {
  readonly cfg: WatchConfig;
  private readonly d: WatchDeps;
  private readonly client: PoliteFeedClient;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  readonly results: SignalResult[] = [];
  private readonly verCache = new Map<string, NewsVerification>();
  private failStreak = 0;

  constructor(cfg: WatchConfig, d: WatchDeps) {
    this.cfg = cfg;
    this.d = d;
    this.now = d.now ?? Date.now;
    this.client = new PoliteFeedClient(d.fetch, this.now);
  }

  private log(s: string) {
    this.d.log?.(s);
  }
  private feedClass = (id: string) => this.cfg.feeds.find((f) => f.id === id)?.class;

  /** Waits for the queued enquiries (call before exiting). */
  async drain(): Promise<void> {
    await this.queue;
  }

  async tick(): Promise<TickResult> {
    const t = this.now();
    const st = this.d.store.state;
    const { articles, statuses } = await this.client.fetchDue(this.cfg.feeds, this.cfg.intervalMs);
    const { articles: uniq } = dedupeArticles(articles);
    const res: TickResult = { at: t, baseline: false, statuses, fetched: articles.length, newArticles: 0, relevantNew: 0, alerts: [], ignored: [], suppressed: [], degraded: false, blind: false };

    const due = statuses.filter((s) => s.state !== "not_due" && s.state !== "backoff");
    const failed = statuses.filter((s) => s.state === "error" || s.state === "backoff");
    res.blind = due.length > 0 && due.every((s) => s.state === "error") && articles.length === 0;
    this.failStreak = failed.length * 2 >= this.cfg.feeds.length ? this.failStreak + 1 : 0;

    const fresh = uniq.filter((a) => !(a.id in st.seen));
    for (const a of fresh) st.seen[a.id] = t;
    res.newArticles = fresh.length;

    if (!st.baselineDone && this.cfg.baseline && fresh.length > 0) {
      st.baselineDone = true;
      res.baseline = true;
      this.log(`référence initiale: ${fresh.length} article(s) déjà publiés enregistrés sans alerte`);
      this.d.store.save();
      return res;
    }
    st.baselineDone = st.baselineDone || fresh.length > 0;

    const inWindow = new Set(st.window.map((a) => a.id));
    for (const a of fresh) {
      const rel = scoreArticle(a, this.cfg.terms);
      if (!rel.relevant) continue;
      const age = t - (a.publishedAt ?? t);
      if (age > this.cfg.maxAgeMs) {
        res.ignored.push({ title: a.title, reason: `article trop ancien à la première lecture (${Math.round(age / 60_000)} min)` });
        continue;
      }
      res.relevantNew++;
      if (!inWindow.has(a.id)) st.window.push(a);
    }
    st.window = st.window.slice(-300);

    // evaluate every story of the window (a rate-limited or still-unverified story is retried naturally)
    const stories = clusterStories(st.window);
    for (const story of stories) {
      const ids = new Set(story.articles.map((a) => a.id));
      const key = [...ids].sort().join(",");
      let v = this.verCache.get(key);
      const existing = st.alerts.find((r) => r.articleIds.some((id) => ids.has(id)));
      if (!v) {
        v = await verifyNews({ articles: story.articles, feedClass: this.feedClass, terms: this.cfg.terms, checkMint: this.d.checkMint ? (m) => timeboxed(this.d.checkMint!(m), this.cfg.fastCheckMs) : undefined });
        this.verCache.set(key, v);
      }
      if (existing) existing.articleIds = [...new Set([...existing.articleIds, ...ids])];
      const isNew = !existing;
      if (isNew && RANK[v.level] < 1) {
        if (story.articles.some((a) => a.id in st.seen && st.seen[a.id] === t)) res.ignored.push({ title: story.title, reason: "source unique, non officielle: en attente de recoupement (aucune alerte)" });
        continue;
      }
      if (!isNew && RANK[v.level] <= RANK[existing!.level]) continue; // already alerted at this level or higher: no repetition
      if (st.alertTimes.filter((x) => t - x <= 3_600_000).length >= this.cfg.maxAlertsPerHour) {
        res.suppressed.push(`${story.title.slice(0, 80)} — limite de ${this.cfg.maxAlertsPerHour} alertes/heure atteinte (réessayé au prochain cycle)`);
        continue;
      }
      const sorted = [...story.articles].sort((a, b) => (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity));
      const anchor = sorted[0]!;
      const firstSeen = Math.min(...story.articles.map((a) => st.seen[a.id] ?? t));
      const published = anchor.publishedAt ?? firstSeen;
      const relevance = scoreArticle({ title: story.articles.map((a) => a.title).join(" . "), summary: story.articles.map((a) => a.summary).join(" "), url: story.articles.map((a) => a.url).join(" ") }, this.cfg.terms);
      const signal: NewsSignal = { kind: isNew ? "new" : "update", priorLevel: isNew ? null : existing!.level, anchor, articles: sorted, relevance, verification: v, times: { published: Math.min(published, firstSeen), received: firstSeen }, provenance: this.d.provenance ?? "rss" };
      // record BEFORE sending: a crash or a restart must never produce a second alert for the same story
      if (isNew) st.alerts.push({ anchorId: anchor.id, articleIds: [...ids], level: v.level, stage1At: t, upgrades: 0 });
      else {
        existing!.level = v.level;
        existing!.upgrades++;
      }
      st.alertTimes.push(t);
      this.d.store.save();
      const { result, investigate } = await sendFirstAlert(signal, { notifier: this.d.notifier, now: this.now, fastCheckMs: this.cfg.fastCheckMs, findHomonyms: this.d.findHomonyms, detective: this.d.detective });
      res.alerts.push(result);
      this.results.push(result);
      this.d.eventLog?.({ at: t, type: signal.kind === "new" ? "alert1" : "update", level: v.level, basis: v.basis, title: anchor.title, url: anchor.url, address: v.address, delays: result.delays });
      this.log(`${signal.kind === "new" ? "ALERTE" : "MISE À JOUR"} ${v.level} (${v.basis}): ${anchor.title.slice(0, 90)}`);
      if (investigate) {
        this.queue = this.queue
          .then(async () => {
            const r = await investigate();
            const i = this.results.indexOf(result);
            if (i >= 0) this.results[i] = r;
            this.d.eventLog?.({ at: this.now(), type: "alert2", title: anchor.title, mint: r.detective?.mint, status: r.detective?.status, delays: r.delays });
            this.log(`enquête terminée (${r.detective?.status}): ${r.detective?.mint}`);
          })
          .catch((e) => this.log(`enquête interrompue: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    for (const ig of res.ignored) this.d.eventLog?.({ at: t, type: "ignored", ...ig });

    // degraded-source notice (at most one per 6 h): "no alert" must not be read as "no announcement"
    if (this.failStreak >= this.cfg.degradedAfter && (st.lastDegradedNoticeAt === null || t - st.lastDegradedNoticeAt > 6 * 3_600_000)) {
      st.lastDegradedNoticeAt = t;
      res.degraded = true;
      await this.d.notifier.send(`SURVEILLANCE DÉGRADÉE — Breaking Signal\nDepuis ${this.failStreak} cycles, au moins la moitié des sources est illisible (${failed.map((f) => `${f.id}: ${f.reason ?? f.state}`).slice(0, 5).join(" ; ")}).\nL'absence d'alerte ne signifie PAS l'absence d'annonce: ces sources sont INCONNUES.`);
    }
    this.d.store.save();
    return res;
  }

  /** Polls until `signal` aborts. A failing tick never stops the loop. */
  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.d.sleep ?? ((ms: number, s?: AbortSignal) => new Promise<void>((r) => { const h = setTimeout(r, ms); s?.addEventListener("abort", () => { clearTimeout(h); r(); }, { once: true }); }));
    while (!signal.aborted) {
      const t0 = this.now();
      try {
        const r = await this.tick();
        this.log(`cycle: ${r.fetched} article(s) lus, ${r.newArticles} nouveau(x), ${r.relevantNew} pertinent(s), ${r.alerts.length} alerte(s)${r.blind ? " — AUCUNE SOURCE LISIBLE (inconnu, pas « rien à signaler »)" : ""}${r.statuses.some((s) => s.state === "error") ? ` · sources en erreur: ${r.statuses.filter((s) => s.state === "error").map((s) => s.id).join(", ")}` : ""}`);
        this.d.eventLog?.({ at: t0, type: "tick", fetched: r.fetched, newArticles: r.newArticles, relevantNew: r.relevantNew, alerts: r.alerts.length, blind: r.blind, errors: r.statuses.filter((s) => s.state === "error").map((s) => s.id) });
      } catch (e) {
        this.log(`erreur de cycle: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(Math.max(1000, this.cfg.intervalMs - (this.now() - t0)), signal);
    }
    await this.drain();
    this.d.store.save();
  }
}

async function timeboxed<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let h: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => (h = setTimeout(() => r(null), ms)))]);
  } catch {
    return null;
  } finally {
    if (h) clearTimeout(h);
  }
}

export type { Article };
