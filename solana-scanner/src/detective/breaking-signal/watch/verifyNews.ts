/**
 * Verification of a news story (several articles about one event). Levels and explicit criteria:
 *
 *   CONFIRMÉ     N4 a valid Solana address is cited by a source of OFFICIAL class (an official feed or an official domain)
 *                AND N5 that address is a mint on-chain.
 *   PROBABLE     N1 at least two independent publishers report the event, or N2 an official-class source reports it.
 *                The contract, if any, is NOT confirmed by an official source.
 *   NON VÉRIFIÉ  a single non-official report, or anything else (including every token that merely uses a name).
 *
 * "Independent" = different publishers. The press repeating a rumour is not an official announcement: the basis is always shown.
 */

import { hostOf } from "../extract.ts";
import type { OnchainQuick } from "../types.ts";
import type { Article } from "../../social-radar/types.ts";
import type { FeedClass } from "./feeds.ts";
import type { WatchTerms } from "./relevance.ts";
import { findAddresses } from "../../social-radar/text.ts";

export type NewsLevel = "CONFIRMÉ" | "PROBABLE" | "NON VÉRIFIÉ";
export type NewsBasis = "source officielle" | "recoupement presse" | "source unique";

export interface NewsCriterion {
  id: string;
  ok: boolean | null;
  text: string;
}

export interface NewsVerification {
  level: NewsLevel;
  basis: NewsBasis;
  criteria: NewsCriterion[];
  publishers: string[];
  officialSources: string[];
  /** The address the story points at (cited, valid format, unambiguous), or null. */
  address: string | null;
  /** True only when an official-class source cites it. */
  addressOfficial: boolean;
  citedBy: string[];
  onchain: OnchainQuick | null;
  notes: string[];
}

export const RANK: Record<NewsLevel, number> = { "NON VÉRIFIÉ": 0, PROBABLE: 1, CONFIRMÉ: 2 };

export interface VerifyNewsInput {
  articles: Article[];
  feedClass: (feedId: string) => FeedClass | undefined;
  terms: WatchTerms;
  checkMint?: (mint: string) => Promise<OnchainQuick | null>;
}

const isOfficial = (a: Article, i: VerifyNewsInput): boolean => {
  if (i.feedClass(a.feed) === "official") return true;
  const h = hostOf(a.url);
  return h !== null && i.terms.officialDomains.some((d) => h === d || h.endsWith(`.${d}`));
};

export async function verifyNews(i: VerifyNewsInput): Promise<NewsVerification> {
  const notes: string[] = [];
  const publishers = [...new Set(i.articles.map((a) => a.publisher.toLowerCase()))];
  const official = i.articles.filter((a) => isOfficial(a, i));
  const officialSources = [...new Set(official.map((a) => a.publisher))];

  const cites = new Map<string, Article[]>();
  for (const a of i.articles) for (const addr of findAddresses(`${a.title} ${a.summary} ${a.url}`)) cites.set(addr, [...(cites.get(addr) ?? []), a]);
  let address: string | null = null;
  let citedBy: string[] = [];
  if (cites.size === 1) {
    [address] = [...cites.keys()];
    citedBy = [...new Set(cites.get(address!)!.map((a) => a.publisher))];
  } else if (cites.size > 1) {
    notes.push(`${cites.size} adresses différentes citées: aucune n'est retenue (ambiguïté)`);
  }
  const addressOfficial = address !== null && cites.get(address)!.some((a) => isOfficial(a, i));
  let onchain: OnchainQuick | null = null;
  if (address && i.checkMint) onchain = await i.checkMint(address);
  const mintOk = address === null ? null : onchain === null ? null : onchain.state === "valid_mint" ? true : onchain.state === "unknown" ? null : false;

  const n1 = publishers.length >= 2;
  const n2 = official.length > 0;
  const criteria: NewsCriterion[] = [
    { id: "N1", ok: n1, text: `${publishers.length} éditeur(s) indépendant(s): ${publishers.slice(0, 4).join(", ")}` },
    { id: "N2", ok: n2, text: n2 ? `source de classe officielle: ${officialSources.join(", ")}` : "aucune source de classe officielle" },
    { id: "N3", ok: address !== null, text: address ? `adresse citée par ${citedBy.length} éditeur(s)` : "aucune adresse unique citée" },
    { id: "N4", ok: address === null ? null : addressOfficial, text: address === null ? "sans objet" : addressOfficial ? "adresse citée par une source officielle" : "adresse NON confirmée par une source officielle" },
    { id: "N5", ok: mintOk, text: address === null ? "sans objet" : mintOk === true ? "l'adresse est un mint SPL on-chain" : mintOk === false ? `l'adresse n'est pas un mint valide (${onchain?.state})` : "vérification on-chain indisponible dans le délai" },
  ];
  let level: NewsLevel = "NON VÉRIFIÉ";
  let basis: NewsBasis = "source unique";
  if (address && addressOfficial && mintOk === true) {
    level = "CONFIRMÉ";
    basis = "source officielle";
  } else if (n2) {
    level = "PROBABLE";
    basis = "source officielle";
  } else if (n1) {
    level = "PROBABLE";
    basis = "recoupement presse";
  }
  if (address && !addressOfficial) notes.push("adresse citée par la presse seulement: à ne pas utiliser sans confirmation officielle");
  if (mintOk === false) notes.push("l'adresse citée n'est pas un mint valide: possible erreur ou fausse adresse");
  return { level, basis, criteria, publishers, officialSources, address, addressOfficial, citedBy, onchain, notes };
}
