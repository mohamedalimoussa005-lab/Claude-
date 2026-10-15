/**
 * Offline simulation of the watch loop on a virtual clock (60 s per cycle). Every article is FICTITIOUS and says so in its
 * text. Nothing here reads a real feed: delays measured in this mode are simulated, never real detection delays.
 */

import { WATCH_FEEDS } from "./feeds.ts";
import type { FeedFetcher, WatchFeed } from "./feeds.ts";
import { FAKE_MINT, TRUMP_MINT } from "../sources.ts";

interface Scripted {
  tick: number;
  feed: string;
  title: string;
  publisher: string;
  summary?: string;
  /** Publication time relative to the cycle start (ms, negative = before). */
  ageMs?: number;
}

export const SIM_SCRIPT: Scripted[] = [
  { tick: 0, feed: "coindesk", title: "Trump Media explores crypto treasury plan (FICTIF)", publisher: "CoinDesk", ageMs: -2 * 3_600_000 },
  { tick: 2, feed: "coindesk", title: "Trump team teases new memecoin launch on Solana (FICTIF)", publisher: "CoinDesk", ageMs: -40_000 },
  { tick: 3, feed: "decrypt", title: "Trump team teases new memecoin launch, sources say (FICTIF)", publisher: "Decrypt", ageMs: -30_000 },
  { tick: 4, feed: "theblock", title: "Trump team new memecoin launch on Solana draws attention (FICTIF)", publisher: "The Block", ageMs: -20_000 },
  { tick: 4, feed: "solana-news", title: "Trump team memecoin launch is live on Solana (FICTIF)", publisher: "Solana Foundation", summary: `Official contract address: ${TRUMP_MINT}`, ageMs: -15_000 },
  { tick: 6, feed: "cryptoslate", title: "Trump Inu token launches with big promises (FICTIF)", publisher: "CryptoSlate", summary: `New token ${FAKE_MINT} uses the Trump name`, ageMs: -10_000 },
];

export const SIM_TICKS = 8;
export const SIM_START = Date.parse("2026-10-14T09:00:00Z");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function createSimulation(feeds: WatchFeed[] = WATCH_FEEDS, start = SIM_START) {
  let tick = 0;
  let realAtTick = Date.now();
  // virtual minutes + REAL elapsed time inside a cycle, so stage-to-stage delays (alert 1 → enquiry → alert 2) are really measured
  const now = () => start + tick * 60_000 + (Date.now() - realAtTick);
  const byUrl = new Map(feeds.map((f) => [f.url, f]));
  const fetchFeed: FeedFetcher = async (url) => {
    const f = byUrl.get(url);
    if (!f) return { status: 404, text: async () => "" };
    const items: string[] = [`<item><title>Markets wrap ${f.id} (FICTIF)</title><link>https://example.test/${f.id}/wrap</link><pubDate>${new Date(start - 3_600_000).toUTCString()}</pubDate><description>Routine market summary.</description></item>`];
    for (const s of SIM_SCRIPT.filter((x) => x.feed === f.id && x.tick <= tick)) {
      const published = x(start + s.tick * 60_000 + (s.ageMs ?? 0));
      items.push(`<item><title>${esc(s.title)}${f.kind === "google" ? ` - ${s.publisher}` : ""}</title><link>https://example.test/${f.id}/${s.tick}</link><pubDate>${published}</pubDate><description>${esc(s.summary ?? "")}</description><source url="https://example.test">${esc(s.publisher)}</source></item>`);
    }
    return { status: 200, text: async () => `<?xml version="1.0"?><rss version="2.0"><channel><title>${f.id}</title>${items.join("")}</channel></rss>` };
  };
  return {
    fetch: fetchFeed,
    now,
    advance: () => {
      tick++;
      realAtTick = Date.now();
    },
    get tick() {
      return tick;
    },
  };
}
const x = (ms: number) => new Date(ms).toUTCString();
