/** Relevance of an article for Breaking Signal: priority people/organizations, crypto and launch vocabulary, cited addresses. Pure. */

import { findAddresses, norm } from "../../social-radar/text.ts";
import type { Article } from "../../social-radar/types.ts";

export interface WatchTerms {
  priorityEntities: string[];
  /** Crypto / project vocabulary. */
  cryptoTerms: string[];
  /** Launch / announcement vocabulary. */
  launchTerms: string[];
  /** Domains whose own publications count as an OFFICIAL source (in addition to feeds of class "official"). */
  officialDomains: string[];
}

export const DEFAULT_TERMS: WatchTerms = {
  priorityEntities: ["trump", "donald trump", "melania", "trump media", "truth social", "world liberty financial", "elon musk", "musk", "vitalik buterin", "changpeng zhao", "pump.fun", "pumpfun", "solana foundation"],
  cryptoTerms: ["memecoin", "meme coin", "meme token", "token", "crypto", "solana", "airdrop", "pump.fun", "pumpfun", "dex", "launchpad", "blockchain", "coin"],
  launchTerms: ["launch", "launches", "launched", "launching", "unveils", "announces", "announced", "introduces", "debuts", "rolls out", "new coin", "new token", "official coin", "official token", "official meme", "airdrop", "presale", "mint", "contract address"],
  officialDomains: ["solana.com"],
};

export interface Relevance {
  relevant: boolean;
  score: number;
  entities: string[];
  crypto: string[];
  launch: string[];
  addresses: string[];
  priority: boolean;
}

const hits = (text: string, terms: string[]): string[] => {
  const hay = ` ${norm(text)} `;
  return [...new Set(terms.filter((t) => hay.includes(` ${norm(t)} `)))];
};

export function scoreArticle(a: Pick<Article, "title" | "summary" | "url">, terms: WatchTerms = DEFAULT_TERMS): Relevance {
  const text = `${a.title} ${a.summary}`;
  const entities = hits(text, terms.priorityEntities);
  const crypto = hits(text, terms.cryptoTerms);
  const launch = hits(text, terms.launchTerms);
  const addresses = findAddresses(`${text} ${a.url}`);
  // an address alone is not enough (it could be anything): it must come with crypto vocabulary
  const relevant = (entities.length > 0 && (crypto.length > 0 || launch.length > 0) && !(launch.length > 0 && crypto.length === 0 && entities.every((e) => ["musk", "elon musk"].includes(e)))) || (addresses.length > 0 && crypto.length > 0) || (launch.length > 0 && crypto.some((c) => ["memecoin", "meme coin", "meme token", "airdrop", "launchpad"].includes(c)));
  const score = entities.length * 2 + Math.min(crypto.length, 3) + Math.min(launch.length, 2) * 2 + (addresses.length ? 3 : 0);
  return { relevant, score, entities, crypto, launch, addresses, priority: entities.some((e) => e.includes("trump") || e.includes("melania")) };
}
