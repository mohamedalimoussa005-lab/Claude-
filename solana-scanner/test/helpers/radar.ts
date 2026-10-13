/** Offline fixtures for the Social Radar: RSS/Atom/GDELT/DEX Screener payloads and fake ports. No network. */
import type { Fetcher } from "../../src/detective/social-radar/NewsCollector.ts";
import type { RadarDex } from "../../src/detective/social-radar/TopicToTokenMatcher.ts";

export const NOW = Date.parse("2026-10-13T12:00:00Z");
export const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toUTCString();

export const item = (title: string, publisher: string, h: number, url?: string, desc = "") =>
  `<item><title><![CDATA[${title} - ${publisher}]]></title><link>${url ?? `https://news.google.com/rss/articles/${encodeURIComponent(publisher + title).slice(0, 40)}?oc=5&utm_source=x`}</link><pubDate>${hoursAgo(h)}</pubDate><description><![CDATA[${desc}]]></description><source url="https://${publisher.toLowerCase().replace(/\W/g, "")}.com">${publisher}</source></item>`;
export const rss = (items: string[], title = "Top stories") => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items.join("")}</channel></rss>`;
export const atom = (entries: { title: string; href: string; h: number }[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>${entries.map((e) => `<entry><title>${e.title}</title><link href="${e.href}"/><updated>${new Date(NOW - e.h * 3_600_000).toISOString()}</updated></entry>`).join("")}</feed>`;

export const MINT1 = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
export const MINT2 = "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K";
export const MINT3 = "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj";
export const MINT4 = "47fwKU1UvbtatYoFYp7ThLkYjqBudAv8UbuhBLf2CK4G";

export const pair = (mint: string, name: string, symbol: string, over: Record<string, unknown> = {}) => ({
  chainId: "solana",
  dexId: "raydium",
  pairAddress: `pair${symbol}${mint.slice(0, 4)}`,
  url: `https://dexscreener.com/solana/${mint}`,
  baseToken: { address: mint, name, symbol },
  quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  liquidity: { usd: 50_000 },
  pairCreatedAt: NOW - 3_600_000 * 5,
  ...over,
});

export interface FakeDexOpts {
  search?: Record<string, unknown[]>;
  pools?: Record<string, unknown[]>;
  profiles?: unknown[] | Error;
  fail?: boolean;
}
export function fakeDex(o: FakeDexOpts = {}): RadarDex & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searchPairs: async (q) => (calls.push(`search:${q}`), o.fail ? Promise.reject(new Error("503")) : { schemaVersion: "1.0.0", pairs: o.search?.[q] ?? [] }),
    getLatestTokenProfiles: async () => (calls.push("profiles"), o.fail || o.profiles instanceof Error ? Promise.reject(new Error("503")) : o.profiles ?? []),
    getTokenPools: async (_c, a) => (calls.push(`pools:${a}`), o.fail ? Promise.reject(new Error("503")) : o.pools?.[a] ?? []),
  };
}

export function fakeFetch(routes: { match: RegExp; status?: number; body: string | (() => string) | Error }[]): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const r = routes.find((x) => x.match.test(url));
    if (!r) return { status: 404, text: async () => "" };
    if (r.body instanceof Error) throw r.body;
    return { status: r.status ?? 200, text: async () => (typeof r.body === "function" ? r.body() : r.body) };
  }) as Fetcher & { urls: string[] };
  f.urls = urls;
  return f;
}

export const gdeltTimeline = (values: number[], stepMin = 15) => {
  const end = NOW;
  return JSON.stringify({ timeline: [{ series: "Volume Intensity", data: values.map((v, i) => { const t = new Date(end - (values.length - 1 - i) * stepMin * 60_000); const p = (n: number) => String(n).padStart(2, "0"); return { date: `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z`, value: v }; }) }] });
};
