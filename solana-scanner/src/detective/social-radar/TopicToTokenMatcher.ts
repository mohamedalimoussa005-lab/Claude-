/**
 * Links a story to Solana tokens WITHOUT inventing an affiliation. Ladder of proof:
 *   ADRESSE (5, FAIT)        an article cites the mint address and DEX Screener lists a pool for it
 *   LIEN_DECLARE (5, FAIT)   the project's declared site/X account appears in the articles
 *   NOM_ET_SYMBOLE (4, INDICE)  name equals a phrase of the story and the symbol matches too
 *   NOM_EXACT (3, INDICE)    name equals a phrase of the story
 *   PROFIL_TEXTE (2, INDICE) the project's own DEX Screener profile text mentions the phrase
 *   SYMBOLE_SEUL (2, INDICE) only the symbol matches (homonyms are the rule for short symbols)
 * Anything weaker is not reported. Several tokens with the same name are all listed, with a warning.
 */

import { RadarBudget } from "./budget.ts";
import { norm, STOP } from "./text.ts";
import type { Match, MatchLevel, Story } from "./types.ts";

export interface RadarDex {
  searchPairs(query: string): Promise<unknown>;
  getLatestTokenProfiles(): Promise<unknown>;
  getTokenPools(chainId: string, tokenAddress: string): Promise<unknown>;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface Cand {
  mint: string;
  name: string | null;
  symbol: string | null;
  pairAddress: string | null;
  url: string | null;
  liquidityUsd: number | null;
  createdAt: number | null;
  hosts: Set<string>;
  handles: Set<string>;
}

const SKIP_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|news\.google\.com|google\.com|youtube\.com|facebook\.com|instagram\.com|tiktok\.com|discord\.gg|discord\.com|linktr\.ee|github\.com|medium\.com|wikipedia\.org)$/i;
const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const handleOf = (u: string): string | null => u.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i)?.[1]?.toLowerCase() ?? null;

export function candidatesFromPairs(raw: unknown): Cand[] {
  const pairs = Array.isArray(raw) ? raw : Array.isArray(obj(raw).pairs) ? (obj(raw).pairs as unknown[]) : [];
  const best = new Map<string, Cand>();
  for (const p0 of pairs) {
    const p = obj(p0);
    if (p.chainId !== "solana") continue;
    const base = obj(p.baseToken);
    const mint = str(base.address);
    if (!mint) continue;
    const info = obj(p.info);
    const links = [...(Array.isArray(info.websites) ? info.websites : []), ...(Array.isArray(info.socials) ? info.socials : [])].map((x) => str(obj(x).url)).filter((x): x is string => x !== null);
    const c: Cand = { mint, name: str(base.name), symbol: str(base.symbol), pairAddress: str(p.pairAddress), url: str(p.url), liquidityUsd: numOrNull(obj(p.liquidity).usd), createdAt: numOrNull(p.pairCreatedAt), hosts: new Set(links.map(hostOf).filter((h): h is string => h !== null && !SKIP_HOSTS.test(h))), handles: new Set(links.map(handleOf).filter((h): h is string => h !== null)) };
    const prev = best.get(mint);
    if (!prev || (c.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) best.set(mint, { ...c, createdAt: Math.min(c.createdAt ?? Infinity, prev?.createdAt ?? Infinity) === Infinity ? null : Math.min(c.createdAt ?? Infinity, prev?.createdAt ?? Infinity) });
  }
  return [...best.values()];
}

export interface MatcherDeps {
  dex: RadarDex;
  budget: RadarBudget;
  now?: () => number;
}
export interface MatcherConfig {
  termsPerStory: number;
  minTermLength: number;
  minLiquidityWarn: number;
  oldTokenDays: number;
}
export const MATCHER_CONFIG: MatcherConfig = { termsPerStory: 3, minTermLength: 4, minLiquidityWarn: 1000, oldTokenDays: 30 };

const LABEL: Record<MatchLevel, string> = {
  ADRESSE: "l'adresse du token est citée dans un article et DEX Screener liste un pool pour elle",
  LIEN_DECLARE: "le site ou le compte X déclaré par le projet apparaît dans les articles",
  NOM_ET_SYMBOLE: "le nom du token est identique à une expression de l'actualité et son symbole correspond aussi",
  NOM_EXACT: "le nom du token est identique à une expression de l'actualité (aucune affiliation établie)",
  PROFIL_TEXTE: "le texte du profil DEX Screener du projet mentionne l'expression (déclaration du projet lui-même)",
  SYMBOLE_SEUL: "seul le symbole du token correspond (homonymie probable)",
};
const STRENGTH: Record<MatchLevel, 1 | 2 | 3 | 4 | 5> = { ADRESSE: 5, LIEN_DECLARE: 5, NOM_ET_SYMBOLE: 4, NOM_EXACT: 3, PROFIL_TEXTE: 2, SYMBOLE_SEUL: 2 };

export class TopicToTokenMatcher {
  readonly notes: string[] = [];
  private profiles: { mint: string; text: string; hosts: Set<string>; handles: Set<string> }[] | null = null;
  private profilesFailed = false;
  private readonly d: MatcherDeps;
  private readonly cfg: MatcherConfig;
  constructor(d: MatcherDeps, cfg: MatcherConfig = MATCHER_CONFIG) {
    this.d = d;
    this.cfg = cfg;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!this.d.budget.take("api.dexscreener.com")) return null;
    try {
      return await fn();
    } catch (e) {
      this.notes.push(`DEX Screener indisponible: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async loadProfiles(): Promise<NonNullable<typeof this.profiles>> {
    if (this.profiles || this.profilesFailed) return this.profiles ?? [];
    const raw = await this.call(() => this.d.dex.getLatestTokenProfiles());
    if (!Array.isArray(raw)) {
      this.profilesFailed = true;
      if (raw !== null) this.notes.push("profils DEX Screener: réponse inattendue");
      return [];
    }
    this.profiles = raw.flatMap((p0) => {
      const p = obj(p0);
      if (p.chainId !== "solana" || !str(p.tokenAddress)) return [];
      const links = (Array.isArray(p.links) ? p.links : []).map((x) => str(obj(x).url)).filter((x): x is string => x !== null);
      return [{ mint: str(p.tokenAddress)!, text: norm(`${str(p.description) ?? ""} ${(Array.isArray(p.links) ? p.links : []).map((x) => str(obj(x).label) ?? "").join(" ")}`), hosts: new Set(links.map(hostOf).filter((h): h is string => h !== null && !SKIP_HOSTS.test(h))), handles: new Set(links.map(handleOf).filter((h): h is string => h !== null)) }];
    });
    return this.profiles;
  }

  /** Terms worth searching: tickers cited, then the story's longest recurring phrases. */
  termsOf(story: Story): string[] {
    const phrases = story.phrases.filter((p) => p.length >= this.cfg.minTermLength && !STOP.has(p) && !/^\d+$/.test(p));
    return [...new Set([...story.tickers.map((t) => t.toLowerCase()), ...phrases])].slice(0, this.cfg.termsPerStory);
  }

  async matchStory(story: Story): Promise<{ matches: Match[]; missing: string[] }> {
    const missing: string[] = [];
    const found = new Map<string, Match>();
    const keep = (m: Match) => {
      const prev = found.get(m.mint);
      if (!prev || m.strength > prev.strength) found.set(m.mint, m);
    };
    const storyHosts = new Set<string>();
    const storyHandles = new Set<string>();
    for (const a of story.articles) for (const m of a.summary.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      const h = hostOf(m[0]);
      if (h && !SKIP_HOSTS.test(h)) storyHosts.add(h);
    }
    for (const a of story.articles) for (const m of `${a.title} ${a.summary}`.matchAll(/(?:^|\s)@([A-Za-z0-9_]{2,15})\b/g)) storyHandles.add(m[1]!.toLowerCase());

    // 1. addresses cited in the articles
    for (const addr of story.addresses) {
      const raw = await this.call(() => this.d.dex.getTokenPools("solana", addr));
      if (raw === null) {
        missing.push(`adresse ${addr.slice(0, 6)}…: vérification DEX Screener impossible`);
        continue;
      }
      const cs = candidatesFromPairs(raw).filter((c) => c.mint === addr);
      if (cs.length === 0) {
        missing.push(`adresse ${addr.slice(0, 6)}… citée dans un article mais aucun pool Solana sur DEX Screener`);
        continue;
      }
      keep(this.build(cs[0]!, "ADRESSE", addr, story, []));
    }

    // 2. name / symbol search
    const terms = this.termsOf(story);
    if (terms.length === 0) missing.push("aucune expression exploitable pour chercher un token");
    const byName = new Map<string, Set<string>>();
    for (const term of terms) {
      const raw = await this.call(() => this.d.dex.searchPairs(term));
      if (raw === null) {
        missing.push(`recherche DEX Screener « ${term} » impossible`);
        continue;
      }
      const cands = candidatesFromPairs(raw);
      for (const c of cands) {
        const n = norm(c.name ?? "");
        const s = norm(c.symbol ?? "");
        if (n) byName.set(n, (byName.get(n) ?? new Set()).add(c.mint));
        const declared = [...c.hosts].some((h) => storyHosts.has(h)) || [...c.handles].some((h) => storyHandles.has(h));
        let level: MatchLevel | null = null;
        if (declared) level = "LIEN_DECLARE";
        else if (n === term && (s === term || story.tickers.some((t) => t.toLowerCase() === s) || s === term.replace(/\s+/g, ""))) level = "NOM_ET_SYMBOLE";
        else if (n === term) level = "NOM_EXACT";
        else if (s === term.replace(/\s+/g, "") && term.length >= this.cfg.minTermLength - 1) level = "SYMBOLE_SEUL";
        if (level) keep(this.build(c, level, term, story, []));
      }
    }

    // 3. the projects' own declared profile text
    const profiles = await this.loadProfiles();
    if (this.profilesFailed) missing.push("profils DEX Screener récents indisponibles");
    for (const p of profiles) {
      if (found.has(p.mint)) continue;
      const hit = terms.find((t) => t.includes(" ") && p.text.includes(t));
      const declared = [...p.hosts].some((h) => storyHosts.has(h)) || [...p.handles].some((h) => storyHandles.has(h));
      if (!hit && !declared) continue;
      const c: Cand = { mint: p.mint, name: null, symbol: null, pairAddress: null, url: `https://dexscreener.com/solana/${p.mint}`, liquidityUsd: null, createdAt: null, hosts: p.hosts, handles: p.handles };
      keep(this.build(c, declared ? "LIEN_DECLARE" : "PROFIL_TEXTE", hit ?? "lien déclaré", story, ["liquidité et date de création non lues (profil seulement)"]));
    }

    // homonym warning
    for (const m of found.values()) {
      const same = byName.get(norm(m.name ?? ""));
      if (!same || same.size < 2 || m.evidence === "FAIT") continue;
      m.warnings.push(`${same.size} tokens Solana portent ce nom: ne pas supposer que celui-ci est « le » token de l'actualité`);
      // a widespread name cannot single out one token: the proof is capped, never raised
      const cap = same.size >= 3 ? 2 : 3;
      if (m.strength > cap) {
        m.strength = cap as 2 | 3;
        m.warnings.push(`force plafonnée à ${cap}/5: nom porté par ${same.size} tokens`);
      }
    }
    const matches = [...found.values()].sort((a, b) => b.strength - a.strength || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, 8);
    return { matches, missing };
  }

  private build(c: Cand, level: MatchLevel, term: string, story: Story, extra: string[]): Match {
    const warnings = [...extra];
    const now = (this.d.now ?? Date.now)();
    if (c.liquidityUsd !== null && c.liquidityUsd < this.cfg.minLiquidityWarn) warnings.push(`liquidité déclarée très faible (${Math.round(c.liquidityUsd)} $)`);
    if (c.createdAt !== null && story.firstSeenAt !== null) {
      const d = (story.firstSeenAt - c.createdAt) / 86_400_000;
      if (d > this.cfg.oldTokenDays) warnings.push(`pool créé ${Math.round(d)} jours avant le premier article: le token n'a pas été lancé en réaction à cette actualité`);
      else if (d < 0) warnings.push(`pool créé ${((-d) * 24).toFixed(1)} h après le premier article`);
    }
    if (c.createdAt !== null && now - c.createdAt < 3_600_000) warnings.push("pool créé il y a moins d'une heure");
    if (story.disputed) warnings.push("actualité contestée: des articles la démentent ou la relativisent");
    if (level === "SYMBOLE_SEUL" || (c.symbol && c.symbol.length <= 3)) warnings.push("symbole court: les homonymes sont la règle");
    return {
      mint: c.mint,
      name: c.name,
      symbol: c.symbol,
      pairAddress: c.pairAddress,
      dexUrl: c.url,
      liquidityUsd: c.liquidityUsd,
      pairCreatedAt: c.createdAt,
      level,
      evidence: level === "ADRESSE" || level === "LIEN_DECLARE" ? "FAIT" : "INDICE",
      strength: STRENGTH[level],
      because: `${LABEL[level]} (« ${term} »)`,
      warnings,
      term,
    };
  }
}
