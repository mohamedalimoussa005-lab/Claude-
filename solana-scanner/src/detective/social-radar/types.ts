/** Social Radar (step 1, free sources only). News and attention are described, never turned into a price prediction. */

export type SourceState = "ok" | "partial" | "unavailable" | "not_used";

export interface SourceStatus {
  source: string;
  state: SourceState;
  requests: number;
  articles: number;
  /** Newest item time seen (ms) — freshness. */
  newestAt: number | null;
  reason: string | null;
}

export interface Article {
  /** Stable id of the normalized (publisher, title). */
  id: string;
  title: string;
  /** Title without the "- Publisher" suffix, lowercased and stripped: the dedup key. */
  norm: string;
  url: string;
  publisher: string;
  /** Feed it came from (e.g. "google-news:top", "gdelt:artlist"). */
  feed: string;
  publishedAt: number | null;
  summary: string;
}

export type Stance = "confirm" | "deny" | "neutral";

export interface Story {
  id: string;
  /** Title of the earliest article. */
  title: string;
  articles: Article[];
  distinctPublishers: number;
  firstSeenAt: number | null;
  newestAt: number | null;
  /** Articles disagree (some deny/debunk what others confirm). */
  disputed: boolean;
  stance: { confirm: number; deny: number; neutral: number };
  keywords: string[];
  phrases: string[];
  addresses: string[];
  tickers: string[];
}

export type TrendState = "accelerating" | "steady" | "fading" | "new" | "unknown";

export interface Trend {
  state: TrendState;
  /** Human text; "TENDANCE INCONNUE" when data are insufficient. */
  label: string;
  basis: "gdelt-timeline" | "article-times" | "none";
  recent: number | null;
  baseline: number | null;
  ratio: number | null;
  reason: string | null;
}

export type MatchLevel = "ADRESSE" | "LIEN_DECLARE" | "NOM_ET_SYMBOLE" | "NOM_EXACT" | "SYMBOLE_SEUL" | "PROFIL_TEXTE";

export interface Match {
  mint: string;
  name: string | null;
  symbol: string | null;
  pairAddress: string | null;
  dexUrl: string | null;
  liquidityUsd: number | null;
  pairCreatedAt: number | null;
  level: MatchLevel;
  /** FACT only for an exact address or a declared link; every name/symbol match is an INDICE. */
  evidence: "FAIT" | "INDICE";
  strength: 1 | 2 | 3 | 4 | 5;
  because: string;
  warnings: string[];
  term: string;
}

export interface StoryResult {
  story: Story;
  trend: Trend;
  matches: Match[];
  missing: string[];
}

export const RADAR_DISCLAIMERS: readonly string[] = [
  "Une actualité virale ne signifie pas que le prix d'un token va monter: ce rapport décrit de l'attention observée, il ne prédit rien et ne constitue pas un conseil.",
  "Une ressemblance de nom ou de symbole n'est pas une affiliation: seuls une adresse citée ou un lien déclaré par le projet sont des faits.",
  "Aucune publication X n'est collectée (API payante, scraping exclu): les données X sont INCONNUES.",
  "TENDANCE INCONNUE signifie que l'historique disponible est insuffisant pour mesurer une évolution; aucun pourcentage n'est inventé.",
];
