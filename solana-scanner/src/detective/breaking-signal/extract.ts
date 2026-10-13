/** Extraction from a post: Solana addresses (validated), tickers, entities, URLs, launch wording. Pure. */

import { extractPhrases, findAddresses, norm } from "../social-radar/text.ts";
import type { BreakingConfig } from "./config.ts";
import type { Extraction, PostEvent } from "./types.ts";

export function extractFromPost(e: PostEvent, cfg: Pick<BreakingConfig, "launchWords">): Extraction {
  const text = e.text;
  const urls = [...new Set([...(text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []), ...(e.links ?? [])].map((u) => u.replace(/[.,;!?]+$/, "")))];
  // addresses in the text AND inside URLs (e.g. dexscreener.com/solana/<mint>, pump.fun/coin/<mint>)
  const addresses = findAddresses(`${text} ${urls.join(" ")}`);
  const { phrases, tickers } = extractPhrases(text);
  const n = ` ${norm(text)} `;
  const mentionsLaunch = cfg.launchWords.some((w) => n.includes(` ${norm(w)} `) || n.includes(norm(w)));
  // a single capitalized word that only ever opens a sentence ("Details:", "Stay tuned") is not an entity
  const entities = phrases.filter((p) => !GENERIC.has(p)).filter((p) => p.includes(" ") || appearsMidSentence(text, p)).slice(0, 8);
  return { addresses, tickers, entities, urls, mentionsLaunch };
}
const GENERIC = new Set(["here", "there", "today", "tonight", "stay", "details", "big", "simulation", "breaking", "update", "official", "great", "thank", "thanks"]);

export const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

function appearsMidSentence(text: string, word: string): boolean {
  const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index).trimEnd();
    if (before === "" || /[.!?:]$/.test(before)) continue;
    return true;
  }
  return false;
}
