/**
 * Measures how a story's attention changes, with the data really available. Insufficient history → TENDANCE INCONNUE,
 * never an invented percentage. A trend is a description of attention, not a prediction of any price.
 */

import type { TimelinePoint } from "./NewsCollector.ts";
import type { Story, Trend } from "./types.ts";

export interface TrendConfig {
  /** Window for article-time counting (ms). */
  windowMs: number;
  minArticles: number;
  /** GDELT: recent window and baseline window (ms) and minimum points on each side. */
  gdeltRecentMs: number;
  gdeltBaselineMs: number;
  gdeltMinPoints: number;
  accelerating: number;
  fading: number;
}
export const TREND_CONFIG: TrendConfig = { windowMs: 2 * 3_600_000, minArticles: 4, gdeltRecentMs: 6 * 3_600_000, gdeltBaselineMs: 24 * 3_600_000, gdeltMinPoints: 16, accelerating: 2, fading: 0.5 };

const UNKNOWN = (reason: string): Trend => ({ state: "unknown", label: "TENDANCE INCONNUE", basis: "none", recent: null, baseline: null, ratio: null, reason });
const ago = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);

export function trendFromTimeline(points: TimelinePoint[] | null, now: number, cfg: TrendConfig = TREND_CONFIG): Trend | null {
  if (!points || points.length === 0) return null;
  const recent = points.filter((p) => p.t > now - cfg.gdeltRecentMs && p.t <= now);
  const base = points.filter((p) => p.t > now - cfg.gdeltRecentMs - cfg.gdeltBaselineMs && p.t <= now - cfg.gdeltRecentMs);
  if (recent.length < cfg.gdeltMinPoints / 2 || base.length < cfg.gdeltMinPoints) return null;
  const mean = (a: TimelinePoint[]) => a.reduce((s, p) => s + p.v, 0) / a.length;
  const r = mean(recent);
  const b = mean(base);
  if (!(b > 0)) return { ...UNKNOWN("base de comparaison nulle: aucun volume avant la fenêtre récente, évolution non calculable"), basis: "gdelt-timeline", recent: r, baseline: 0 };
  const ratio = r / b;
  const state = ratio >= cfg.accelerating ? "accelerating" : ratio <= cfg.fading ? "fading" : "steady";
  const word = state === "accelerating" ? "en accélération" : state === "fading" ? "en recul" : "stable";
  return { state, label: `${word}: couverture des 6 dernières heures ×${ratio.toFixed(2)} par rapport aux 24 h précédentes (GDELT, part de la couverture mondiale)`, basis: "gdelt-timeline", recent: r, baseline: b, ratio, reason: null };
}

export function trendFromArticles(story: Story, now: number, cfg: TrendConfig = TREND_CONFIG): Trend {
  const times = story.articles.map((a) => a.publishedAt).filter((t): t is number => t !== null);
  if (times.length === 0 || story.firstSeenAt === null) return UNKNOWN("aucune date de publication exploitable");
  const age = now - story.firstSeenAt;
  if (age < 2 * cfg.windowMs) {
    if (story.distinctPublishers >= 2 && story.articles.length >= 2) return { state: "new", label: `NOUVEAU: premier article il y a ${ago(age)}, ${story.articles.length} article(s) de ${story.distinctPublishers} éditeur(s); évolution inconnue (historique trop court)`, basis: "article-times", recent: times.length, baseline: null, ratio: null, reason: "sujet trop récent pour mesurer une évolution" };
    return UNKNOWN(`un seul éditeur ou article, premier article il y a ${ago(age)}`);
  }
  if (story.articles.length < cfg.minArticles) return UNKNOWN(`seulement ${story.articles.length} article(s) lus (minimum ${cfg.minArticles})`);
  const recent = times.filter((t) => t > now - cfg.windowMs).length;
  const base = times.filter((t) => t <= now - cfg.windowMs && t > now - 2 * cfg.windowMs).length;
  if (base === 0) return { ...UNKNOWN("aucun article dans la fenêtre précédente: ratio non calculable (pas de pourcentage inventé)"), basis: "article-times", recent, baseline: 0 };
  const ratio = recent / base;
  const state = ratio >= cfg.accelerating ? "accelerating" : ratio <= cfg.fading ? "fading" : "steady";
  return { state, label: `${state === "accelerating" ? "en accélération" : state === "fading" ? "en recul" : "stable"}: ${recent} article(s) sur les ${ago(cfg.windowMs)} récentes contre ${base} sur les ${ago(cfg.windowMs)} précédentes (flux lus seulement)`, basis: "article-times", recent, baseline: base, ratio, reason: null };
}
