import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseFeed, parseGdeltArticles, parseGdeltTimeline } from "../src/detective/social-radar/NewsCollector.ts";
import { clusterStories, dedupeArticles } from "../src/detective/social-radar/cluster.ts";
import { trendFromArticles, trendFromTimeline } from "../src/detective/social-radar/TrendDetector.ts";
import { RadarBudget } from "../src/detective/social-radar/budget.ts";
import { RADAR_DEFAULTS, renderRadarMarkdown, runRadar } from "../src/detective/social-radar/index.ts";
import type { DetectiveSummary } from "../src/detective/social-radar/index.ts";
import { MINT1, MINT2, MINT3, MINT4, NOW, atom, fakeDex, fakeFetch, gdeltTimeline, item, pair, rss } from "./helpers/radar.ts";

const opts = { ...RADAR_DEFAULTS, gdeltStories: 0 };
const feedOnly = (xml: string) => fakeFetch([{ match: /news\.google\.com\/rss\?/, body: xml }]);
const FEEDS = [{ id: "google-news:top", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", kind: "google" as const }];
const run = (xml: string, dex = fakeDex(), over: Partial<typeof opts> = {}, detective?: (m: string) => Promise<DetectiveSummary>) =>
  runRadar({ ...opts, feeds: FEEDS, ...over }, { fetch: feedOnly(xml), dex, now: () => NOW, sleep: async () => {}, detective });

const BIG = rss([
  item("Moonbird Foundation unveils Frog Coin rewards", "Reuters", 1),
  item("Moonbird Foundation unveils Frog Coin rewards program", "AP News", 1.5),
  item("Frog Coin rewards unveiled by Moonbird Foundation", "CNN", 2),
  item("Storm hits the coast of Portugal", "BBC", 1),
  item("Storm hits Portugal coast overnight", "Guardian", 3),
]);

test("parsing: RSS with CDATA/entities, Atom, GDELT; malformed input never throws", () => {
  const a = parseFeed(rss([item("Fish &amp; Chips become <b>legal</b>", "Reuters", 1, "https://example.com/a?utm_source=x&id=2")]), "f", "google");
  assert.equal(a.length, 1);
  assert.equal(a[0]!.publisher, "Reuters");
  assert.match(a[0]!.title, /^Fish & Chips become/);
  assert.equal(a[0]!.url, "https://example.com/a?id=2", "tracking parameters removed");
  assert.equal(parseFeed(atom([{ title: "T1", href: "https://e.com/1", h: 2 }]), "f").length, 1);
  assert.deepEqual(parseFeed("<<not xml", "f"), []);
  assert.equal(parseGdeltArticles({ articles: [{ url: "https://a.com/x", title: "Hello World", seendate: "20261013T115700Z", domain: "a.com" }, { url: "", title: "" }] }).length, 1);
  assert.deepEqual(parseGdeltArticles("nope"), []);
  assert.equal(parseGdeltTimeline(JSON.parse(gdeltTimeline([1, 2, 3]))).length, 3);
});

test("deduplication: same URL (tracking params), same publisher+title; syndication from other publishers is kept", () => {
  const arts = [
    ...parseFeed(rss([item("Moonbird unveils Frog Coin", "Reuters", 1, "https://r.com/x?utm_source=a")]), "f1", "google"),
    ...parseFeed(rss([item("Moonbird unveils Frog Coin", "Reuters", 1, "https://r.com/x?utm_medium=b")]), "f2", "google"),
    ...parseFeed(rss([item("Moonbird unveils Frog Coin", "Reuters", 1, "https://r.com/other")]), "f3", "google"),
    ...parseFeed(rss([item("Moonbird unveils Frog Coin", "AP News", 1)]), "f4", "google"),
  ];
  const d = dedupeArticles(arts);
  assert.equal(d.articles.length, 2, "Reuters once, AP once");
  assert.equal(d.duplicates, 2);
  const stories = clusterStories(d.articles);
  assert.equal(stories.length, 1);
  assert.equal(stories[0]!.distinctPublishers, 2);
});

test("clustering: articles about one event group together, other events stay apart", async () => {
  const { report } = await run(BIG);
  assert.equal(report.storiesFound, 2);
  const moon = report.stories.find((s) => /Moonbird/.test(s.story.title))!;
  assert.equal(moon.story.articles.length, 3);
  assert.equal(moon.story.distinctPublishers, 3);
});

test("contradictory news: a story with confirmations and denials is flagged disputed, links to both, match warned", async () => {
  const xml = rss([
    item("Moonbird Foundation confirms Frog Coin launch", "Reuters", 1),
    item("Moonbird Foundation denies Frog Coin launch, calls it fake", "AP News", 1.2),
    item("Frog Coin launch by Moonbird Foundation officially announced", "CNN", 2),
  ]);
  const dex = fakeDex({ search: { "frog coin": [pair(MINT1, "Frog Coin", "FROG")] } });
  const { report } = await run(xml, dex);
  const s = report.stories[0]!;
  assert.equal(s.story.disputed, true);
  assert.ok(s.story.stance.deny > 0 && s.story.stance.confirm > 0);
  const m = s.matches.find((x) => x.mint === MINT1)!;
  assert.ok(m, "frog coin matched by name");
  assert.ok(m.warnings.some((w) => /contestée/.test(w)));
  const md = renderRadarMarkdown(report);
  assert.match(md, /Actualité contestée/);
});

test("misleading names: partial names are not reported; symbol-only is weak; homonyms and old tokens are warned; non-Solana ignored", async () => {
  const dex = fakeDex({
    search: {
      "frog coin": [
        pair(MINT1, "Frog Coin", "FROG"), // exact name + symbol cited? symbol not cited → NOM_EXACT
        pair(MINT2, "Frog Coin", "FROGGY", { pairCreatedAt: NOW - 90 * 86_400_000 }), // homonym, 90 days old
        pair(MINT3, "Frog Coin Classic Edition Super", "FCCES"), // partial name → ignored
        { ...pair(MINT4, "Frog Coin", "FROG"), chainId: "ethereum" }, // other chain → ignored
      ],
    },
  });
  const { report } = await run(BIG, dex);
  const ms = report.stories.find((s) => /Moonbird/.test(s.story.title))!.matches;
  assert.deepEqual(ms.map((m) => m.mint).sort(), [MINT1, MINT2].sort());
  for (const m of ms) {
    assert.equal(m.evidence, "INDICE", "a name match is never a FACT");
    assert.ok(m.strength <= 3, "two homonyms cap the strength at 3");
    assert.ok(m.warnings.some((w) => /2 tokens Solana portent ce nom/.test(w)), "homonym warning");
  }
  assert.ok(ms.find((m) => m.mint === MINT2)!.warnings.some((w) => /90 jours avant/.test(w)));
});

test("a cited mint address with a DEX Screener pool is a FACT (ADRESSE); without pool it is a gap, not a match", async () => {
  const xml = rss([
    item(`Moonbird post sends meme token ${MINT1} surging`, "Decrypt", 1),
    item("Moonbird post sends meme token surging, report says", "CoinDesk", 2),
    item(`Fans warn Wolfhound airdrop ${MINT2} cited as scam`, "Decrypt", 1.5),
    item("Fans warn Wolfhound airdrop cited as scam, reports say", "Cointelegraph", 2.5),
  ]);
  const dex = fakeDex({ pools: { [MINT1]: [pair(MINT1, "Other Name", "OTH")], [MINT2]: [] } });
  const { report, ledger } = await run(xml, dex);
  const all = report.stories.flatMap((s) => s.matches);
  const a = all.find((m) => m.mint === MINT1)!;
  assert.equal(a.level, "ADRESSE");
  assert.equal(a.evidence, "FAIT");
  assert.equal(a.strength, 5);
  assert.ok(!all.some((m) => m.mint === MINT2));
  assert.ok(report.stories.flatMap((s) => s.missing).some((m) => /aucun pool Solana/.test(m)));
  const e = ledger.ledger.all().find((x) => x.mint === MINT1)!;
  assert.equal(e.status, "FACT");
  assert.ok(e.url && e.basedOn.length > 0);
});

test("declared link: a project whose declared site appears in an article is LIEN_DECLARE (FACT)", async () => {
  const xml = rss([
    item("Moonbird Foundation unveils Frog Coin rewards", "Reuters", 1, undefined, "Details at https://frogcoin.example/launch"),
    item("Moonbird Foundation unveils Frog Coin rewards program", "AP News", 1.5),
  ]);
  const dex = fakeDex({ search: { "frog coin": [pair(MINT1, "Totally Different", "TDX", { info: { websites: [{ url: "https://frogcoin.example" }], socials: [] } })] } });
  const { report } = await run(xml, dex);
  const m = report.stories[0]!.matches[0]!;
  assert.equal(m.level, "LIEN_DECLARE");
  assert.equal(m.evidence, "FAIT");
});

test("trend: never an invented percentage — few articles, no baseline, short history → TENDANCE INCONNUE", () => {
  const story = (hs: number[]) => clusterStories(parseFeed(rss(hs.map((h, i) => item("Moonbird unveils Frog Coin", `Pub${i}`, h))), "f", "google"))[0]!;
  const few = trendFromArticles(story([10, 9, 8]), NOW);
  assert.equal(few.state, "unknown");
  assert.equal(few.label, "TENDANCE INCONNUE");
  assert.equal(few.ratio, null);
  const noBase = trendFromArticles(story([0.2, 0.3, 0.4, 0.5, 6]), NOW);
  assert.equal(noBase.state, "unknown");
  assert.equal(noBase.ratio, null, "baseline 0 → no ratio, no infinity");
  assert.equal(trendFromArticles(story([0.5, 0.8]), NOW).state, "new");
  const acc = trendFromArticles(story([0.2, 0.4, 0.6, 0.8, 1, 3, 5]), NOW);
  assert.equal(acc.state, "accelerating");
  assert.ok(acc.ratio !== null && acc.ratio >= 2);
});

test("GDELT timeline: ratio of last 6 h to previous 24 h; too short or empty baseline → null/unknown", () => {
  const flat = Array(120).fill(1);
  assert.equal(trendFromTimeline(JSON.parse(gdeltTimeline(flat)).timeline[0].data.map((p: { date: string; value: number }) => ({ t: Date.parse(p.date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")), v: p.value })), NOW)!.state, "steady");
  const pts = (vals: number[]) => parseGdeltTimeline(JSON.parse(gdeltTimeline(vals)));
  const rising = trendFromTimeline(pts([...Array(96).fill(1), ...Array(24).fill(4)]), NOW)!;
  assert.equal(rising.state, "accelerating");
  assert.ok(Math.abs(rising.ratio! - 4) < 0.01);
  assert.equal(trendFromTimeline(pts([1, 2, 3]), NOW), null, "too short");
  assert.equal(trendFromTimeline(null, NOW), null);
  const zero = trendFromTimeline(pts([...Array(96).fill(0), ...Array(24).fill(3)]), NOW)!;
  assert.equal(zero.state, "unknown");
  assert.equal(zero.ratio, null);
});

test("budget exhausted: requests stop at the cap, limits are reported, a report is still produced", async () => {
  const fetch = fakeFetch([{ match: /./, body: BIG }]);
  const feeds = [1, 2, 3, 4].map((i) => ({ id: `f${i}`, url: `https://news.google.com/rss/headlines/section/topic/T${i}?hl=en-US`, kind: "google" as const }));
  const { report } = await runRadar({ ...opts, feeds, maxRequests: 2 }, { fetch, dex: fakeDex(), now: () => NOW, sleep: async () => {} });
  assert.equal(fetch.urls.length, 2);
  assert.ok(report.budget.requests <= 2);
  assert.ok(report.budget.limitsReached.some((l) => /budget de requêtes atteint/.test(l)));
  assert.ok(report.sources.filter((s) => s.state === "unavailable").length >= 2);
  const md = renderRadarMarkdown(report);
  assert.match(md, /Limites atteintes: budget de requêtes atteint/);
});

test("budget: time cap is enforced the same way", () => {
  let t = 0;
  const b = new RadarBudget(100, 1000, () => t);
  assert.equal(b.take("a"), true);
  t = 2000;
  assert.equal(b.take("a"), false);
  assert.ok(b.limitsReached.some((l) => /budget de temps/.test(l)));
});

test("sources unavailable: HTTP 500, network error and garbage → INCONNU, no crash, gap recorded in the ledger", async () => {
  const fetch = fakeFetch([{ match: /google/, status: 500, body: "" }, { match: /bbc/, body: new Error("ECONNRESET") }, { match: /cointelegraph/, body: "<html>captcha</html>" }]);
  const { report, ledger } = await runRadar({ ...opts, feeds: undefined }, { fetch, dex: fakeDex(), now: () => NOW, sleep: async () => {} });
  assert.equal(report.stories.length, 0);
  assert.ok(report.sources.filter((s) => s.source !== "x").every((s) => s.state === "unavailable" || s.state === "partial"));
  assert.ok(report.gaps.some((g) => /aucun article lu/.test(g)));
  const gap = ledger.ledger.all().find((e) => e.type === "data_gap")!;
  assert.equal(gap.status, "UNVERIFIED");
  assert.ok(gap.missing.length > 0);
  assert.match(renderRadarMarkdown(report), /INDISPONIBLE \(INCONNU\)/);
});

test("DEX Screener unavailable: stories are kept, tokens are UNKNOWN (never 'no token exists')", async () => {
  const { report } = await run(BIG, fakeDex({ fail: true }));
  assert.ok(report.stories.length > 0);
  assert.ok(report.stories.every((s) => s.matches.length === 0));
  assert.ok(report.stories.some((s) => s.missing.some((m) => /impossible/.test(m))));
  assert.ok(report.gaps.some((g) => /DEX Screener indisponible/.test(g)));
});

test("no X data: X is reported NON UTILISÉE/INCONNU, no entry sourced from X, no X/Twitter host is ever requested", async () => {
  const fetch = fakeFetch([{ match: /./, body: BIG }]);
  const { report, ledger } = await runRadar({ ...opts, feeds: FEEDS }, { fetch, dex: fakeDex(), now: () => NOW, sleep: async () => {} });
  const x = report.sources.find((s) => s.source === "x")!;
  assert.equal(x.state, "not_used");
  assert.ok(ledger.ledger.all().every((e) => e.source !== "x" && e.type !== "x_post"));
  assert.ok(fetch.urls.every((u) => !/(^|\.)(x|twitter)\.com|nitter|xcancel|apify/i.test(new URL(u).hostname)));
  assert.match(renderRadarMarkdown(report), /Publications X: non collectées \(INCONNU\)/);
  assert.equal(report.budget.costUsd, 0);
});

test("DETECTIVE forwarding: only candidates at or above the strength threshold, top N, one run per token; failures are recorded", async () => {
  const dex = fakeDex({ search: { "frog coin": [pair(MINT1, "Frog Coin", "FROG", { liquidity: { usd: 90_000 } }), pair(MINT2, "Frog Coin", "FROGGY", { liquidity: { usd: 10_000 } })] } });
  const called: string[] = [];
  const det = async (mint: string): Promise<DetectiveSummary> => {
    called.push(mint);
    if (mint === MINT2) throw new Error("rpc down");
    return { mint, mode: "rapide", calls: 12, elapsedMs: 3000, limitsReached: [], status: "done", reason: null, findings: [{ level: "FAIT", text: "Autorité de mint révoquée." }], unknowns: [] };
  };
  const { report } = await run(BIG, dex, { detectiveTop: 2 }, det);
  assert.deepEqual(called, [MINT1, MINT2], "ranked by strength then liquidity");
  assert.equal(report.candidates[0]!.detective!.status, "done");
  assert.equal(report.candidates[1]!.detective!.status, "failed");
  const md = renderRadarMarkdown(report);
  assert.match(md, /Résumé on-chain \(DETECTIVE rapide, 12 appel/);
  assert.match(md, /ÉCHEC/);
  // threshold: symbol-only matches (strength 2) are never forwarded
  called.length = 0;
  const weak = fakeDex({ search: { "frog coin": [pair(MINT3, "Something Else", "FROGCOIN")] } });
  const r2 = await run(BIG, weak, {}, det);
  assert.equal(called.length, 0);
  assert.ok(r2.report.gaps.some((g) => /aucun token candidat/.test(g)));
  // detectiveTop 0
  await run(BIG, dex, { detectiveTop: 0 }, det);
  assert.equal(called.length, 0);
});

test("ledger: news entries are FACTs anchored on URLs, associations FACT only for address/declared link, no hypothesis", async () => {
  const dex = fakeDex({ search: { "frog coin": [pair(MINT1, "Frog Coin", "FROG")] } });
  const { ledger } = await run(BIG, dex);
  const all = ledger.ledger.all();
  assert.ok(all.some((e) => e.source === "news" && e.status === "FACT" && e.url?.startsWith("https://")));
  const assoc = all.filter((e) => e.mint === MINT1);
  assert.ok(assoc.length > 0 && assoc.every((e) => e.status === "INDICATION" && e.limits.length > 0));
  assert.ok(!all.some((e) => e.status === "HYPOTHESIS"));
});

test("report: states what is missing and never predicts prices or advises", async () => {
  const dex = fakeDex({ search: { "frog coin": [pair(MINT1, "Frog Coin", "FROG")] } });
  const { report } = await run(BIG, dex);
  const md = renderRadarMarkdown(report);
  assert.match(md, /ne signifie pas que le prix d'un token va monter/);
  assert.match(md, /TENDANCE INCONNU|NOUVEAU|en accélération|stable|en recul/);
  assert.match(md, /Données manquantes/);
  assert.doesNotMatch(md, /va exploser|to the moon|à acheter|achetez|garanti|hausse prévue|opportunité d'achat/i);
  assert.doesNotMatch(md, /fraude avérée|arnaque/i);
});

test("isolation: radar code never touches scores, trades or X/scraping hosts", () => {
  const dir = new URL("../src/detective/social-radar/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /scoring\/|sendTransaction|signTransaction|simulateTransaction|api\.apify|api\.twitter|api\.x\.com|nitter|xcancel/i, f);
  }
});

test("a widespread name (3+ tokens) is capped at 2/5 and never forwarded to DETECTIVE", async () => {
  const dex = fakeDex({ search: { "frog coin": [pair(MINT1, "Frog Coin", "FROG"), pair(MINT2, "Frog Coin", "FROG"), pair(MINT3, "Frog Coin", "FROG")] } });
  const called: string[] = [];
  const { report } = await run(BIG, dex, {}, async (m) => (called.push(m), { mint: m, mode: "rapide", calls: 0, elapsedMs: 0, limitsReached: [], status: "done", reason: null, findings: [], unknowns: [] }));
  const ms = report.stories.find((s) => /Moonbird/.test(s.story.title))!.matches;
  assert.equal(ms.length, 3);
  assert.ok(ms.every((m) => m.strength === 2 && m.warnings.some((w) => /plafonnée à 2\/5/.test(w))));
  assert.equal(called.length, 0);
});
