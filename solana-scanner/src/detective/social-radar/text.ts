/** Text helpers: normalization, keyword/phrase extraction, address detection, stance. No network. */

import { isSolanaAddress } from "../../social/validate.ts";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m);
}
export const stripTags = (s: string): string => decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export const norm = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9$# ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const STOP = new Set(
  "a about after again all also am an and any are as at be because been before being but by can could did do does for from had has have he her his how i if in into is it its just may me more most my new no not now of on one or our out over say says said she should so some than that the their them then there these they this to up us was we were what when where which who why will with would you your amid via vs".split(" "),
);

/** Capitalized sequences ("Official Trump", "Dogecoin") in the ORIGINAL text, hashtags and $TICKERS. */
export function extractPhrases(title: string): { phrases: string[]; tickers: string[] } {
  const tickers = [...title.matchAll(/(?:^|[^\w$])\$([A-Za-z][A-Za-z0-9]{1,14})\b/g)].map((m) => m[1]!.toUpperCase());
  const tags = [...title.matchAll(/#([A-Za-z][A-Za-z0-9]{2,30})/g)].map((m) => m[1]!.toLowerCase());
  const phrases = new Set<string>(tags);
  for (const m of title.matchAll(/\b([A-Z][\w'’.-]+(?:\s+(?:of|the|de|la|and|&)\s+[A-Z][\w'’.-]+|\s+[A-Z][\w'’.-]+){0,3})/g)) {
    const p = m[1]!.replace(/['’]s$/, "").trim();
    const n = norm(p);
    if (n.length >= 3 && !STOP.has(n)) phrases.add(n);
  }
  return { phrases: [...phrases], tickers: [...new Set(tickers)] };
}

export function keywordsOf(text: string): string[] {
  return [...new Set(norm(text).split(" ").filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

const B58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** Solana-looking addresses in a text (validated by decoding to 32 bytes). */
export function findAddresses(text: string): string[] {
  return [...new Set((text.match(B58) ?? []).filter((a) => isSolanaAddress(a)))];
}

const DENY = /\b(fake|hoax|debunk\w*|false|denies|denied|deny|denying|not true|untrue|misleading|rumou?r|unconfirmed|no evidence|baseless|fabricated|clarif\w+)\b/i;
const CONFIRM = /\b(confirm\w*|announce\w*|officially|official|launch\w*|signs|signed|approves?|approved|unveils?|reveals?)\b/i;
export function stanceOf(text: string): "confirm" | "deny" | "neutral" {
  const d = DENY.test(text);
  const c = CONFIRM.test(text);
  if (d && !c) return "deny";
  if (c && !d) return "confirm";
  if (d && c) return "deny"; // a denial that mentions an announcement is a contradiction signal
  return "neutral";
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

export function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
