/**
 * Event sources. Phase 0 reads NO real X post: the X source reports itself as disconnected, and the product never claims
 * to monitor X unless an official connection is configured AND authorized (not in phase 0: it would be paid).
 */

import { readFileSync } from "node:fs";
import type { PostEvent, PostKind, WatchedAccount } from "./types.ts";

export interface XStatus {
  monitoring: false;
  state: "NON CONNECTÉ" | "JETON PRÉSENT, NON UTILISÉ";
  message: string;
}

/** Phase 0: X is never queried (paid API). A bearer token in the environment is reported but not used. */
export function xStatus(env: Record<string, string | undefined>): XStatus {
  const hasToken = !!(env.BREAKING_SIGNAL_X_BEARER_TOKEN || env.X_BEARER_TOKEN);
  return hasToken
    ? { monitoring: false, state: "JETON PRÉSENT, NON UTILISÉ", message: "Un jeton X est présent dans l'environnement mais la phase 0 interdit tout appel X payant: AUCUN compte n'est surveillé sur X." }
    : { monitoring: false, state: "NON CONNECTÉ", message: "Aucune connexion officielle à X n'est configurée: AUCUN compte n'est surveillé sur X. Les événements viennent de simulations ou de fichiers fournis par vous." };
}

/** Simulated official account (fictitious numeric id: the real X ids must be filled in by the user from the X console). */
export const SIM_ACCOUNT: WatchedAccount = { userId: "900000000000001", handle: "realDonaldTrump", label: "Donald J. Trump — compte SIMULÉ (identifiant fictif)", officialDomains: ["simulated-official.example"] };

/** The official TRUMP mint (public on-chain data) — used so the free read-only checks can run on a real token. */
export const TRUMP_MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
export const FAKE_MINT = "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj";

export interface Scenario {
  id: string;
  title: string;
  expected: "CONFIRMÉ" | "PROBABLE" | "NON VÉRIFIÉ";
  event(now: number, ageMs: number): PostEvent;
  /** Page served for an official-domain link (offline fixtures). */
  pages?: Record<string, string>;
}

const base = (id: string, now: number, ageMs: number, over: Partial<PostEvent>): PostEvent => ({ id, authorId: SIM_ACCOUNT.userId, handle: SIM_ACCOUNT.handle, text: "", createdAt: now - ageMs, url: `https://x.com/${SIM_ACCOUNT.handle}/status/${id}`, kind: "original", provenance: "simulation", ...over });

export const SCENARIOS: Scenario[] = [
  { id: "trump-launch", title: "Annonce d'un memecoin avec l'adresse dans le post", expected: "CONFIRMÉ", event: (n, a) => base("910000000000001", n, a, { text: `SIMULATION: My new Official Trump Meme is HERE! Contract: ${TRUMP_MINT}` }) },
  { id: "trump-page", title: "Annonce avec l'adresse sur la page officielle liée", expected: "CONFIRMÉ", event: (n, a) => base("910000000000002", n, a, { text: "SIMULATION: The new official meme coin is live. Details: https://simulated-official.example/coin" }), pages: { "https://simulated-official.example/coin": `<html><body>Official contract address: ${TRUMP_MINT}</body></html>` } },
  { id: "trump-teaser", title: "Teaser sans adresse (aucun token annoncé)", expected: "PROBABLE", event: (n, a) => base("910000000000003", n, a, { text: "SIMULATION: Big announcement coming soon about our new Official Trump meme coin. Stay tuned!" }) },
  { id: "fake-lookalike", title: "Faux compte au pseudo quasi identique, même texte, autre adresse", expected: "NON VÉRIFIÉ", event: (n, a) => base("910000000000004", n, a, { authorId: "900000000000999", handle: "realDonaIdTrump", text: `SIMULATION: My new Official Trump Meme is HERE! Contract: ${FAKE_MINT}` }) },
  { id: "quote-of-other", title: "Compte surveillé qui cite la publication d'un tiers", expected: "NON VÉRIFIÉ", event: (n, a) => base("910000000000005", n, a, { kind: "quote", text: `SIMULATION: look at this ${FAKE_MINT}` }) },
  { id: "ai-topic", title: "Sujet sans token (cas 2): mention d'un projet d'IA", expected: "PROBABLE", event: (n, a) => base("910000000000006", n, a, { text: "SIMULATION: Very impressed by the Anthropic AI project and its new Claude model. Great things ahead." }) },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Events from a local JSONL file you provide (one PostEvent-like JSON object per line). provenance is forced to "file". */
export function readEventsFile(path: string): { events: PostEvent[]; problems: string[] } {
  const events: PostEvent[] = [];
  const problems: string[] = [];
  readFileSync(path, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const kind = (["original", "reply", "quote", "repost"] as PostKind[]).includes(o.kind as PostKind) ? (o.kind as PostKind) : "original";
      const created = typeof o.createdAt === "string" ? Date.parse(o.createdAt) : typeof o.createdAt === "number" ? o.createdAt : NaN;
      if (typeof o.id !== "string" || typeof o.authorId !== "string" || typeof o.text !== "string" || !Number.isFinite(created)) throw new Error("champs id/authorId/text/createdAt requis");
      events.push({ id: o.id, authorId: o.authorId, handle: String(o.handle ?? ""), text: o.text, createdAt: created, url: typeof o.url === "string" && /^https:\/\//.test(o.url) ? o.url : "", kind, provenance: "file", links: Array.isArray(o.links) ? (o.links as unknown[]).filter((x): x is string => typeof x === "string") : undefined });
    } catch (e) {
      problems.push(`ligne ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return { events, problems };
}

// ---------- PumpPortal (free stream of new pump.fun tokens) ----------

export interface NewTokenEvent {
  mint: string | null;
  name: string | null;
  symbol: string | null;
  signature: string | null;
  receivedAt: number;
  /** Source-side timestamp (ms) if the payload carries one. */
  sourceTime: number | null;
  watchedMatch: string | null;
}

export function parsePumpEvent(raw: unknown, receivedAt: number, watched: string[]): NewTokenEvent | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const mint = typeof r.mint === "string" ? r.mint : null;
  if (!mint && typeof r.signature !== "string") return null; // acknowledgements such as {"message":"Successfully subscribed"}
  const name = typeof r.name === "string" ? r.name : null;
  const symbol = typeof r.symbol === "string" ? r.symbol : null;
  const t = typeof r.timestamp === "number" ? (r.timestamp < 1e12 ? r.timestamp * 1000 : r.timestamp) : null;
  const hay = `${name ?? ""} ${symbol ?? ""}`.toLowerCase();
  return { mint, name, symbol, signature: typeof r.signature === "string" ? r.signature : null, receivedAt, sourceTime: t, watchedMatch: watched.find((w) => hay.includes(w.toLowerCase())) ?? null };
}

export interface PumpWatchResult {
  connected: boolean;
  connectMs: number | null;
  seconds: number;
  events: NewTokenEvent[];
  watchedMatches: NewTokenEvent[];
  firstEventMs: number | null;
  error: string | null;
  payloadKeys: string[];
}

/** Listens to the free subscribeNewToken stream for a few seconds (no key, no wallet, no payment). */
export async function watchPumpPortal(opts: { seconds: number; watched: string[]; now?: () => number; WebSocketImpl?: typeof WebSocket; url?: string }): Promise<PumpWatchResult> {
  const now = opts.now ?? Date.now;
  const WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  const res: PumpWatchResult = { connected: false, connectMs: null, seconds: opts.seconds, events: [], watchedMatches: [], firstEventMs: null, error: null, payloadKeys: [] };
  if (!WS) return { ...res, error: "WebSocket indisponible dans cet environnement" };
  const t0 = now();
  return new Promise<PumpWatchResult>((resolve) => {
    let done = false;
    const keys = new Set<string>();
    const finish = (err: string | null) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      res.error = err ?? res.error;
      res.payloadKeys = [...keys];
      res.watchedMatches = res.events.filter((e) => e.watchedMatch);
      resolve(res);
    };
    const ws = new WS(opts.url ?? "wss://pumpportal.fun/api/data");
    const timer = setTimeout(() => finish(null), opts.seconds * 1000);
    const hard = setTimeout(() => finish(res.connected ? null : "connexion non établie dans le délai"), (opts.seconds + 8) * 1000);
    ws.addEventListener("open", () => {
      res.connected = true;
      res.connectMs = now() - t0;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });
    ws.addEventListener("message", (m: MessageEvent) => {
      const at = now();
      const raw = typeof m.data === "string" ? m.data : String(m.data);
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === "object") Object.keys(o).forEach((k) => keys.add(k));
      } catch {
        /* not JSON */
      }
      const ev = parsePumpEvent(raw, at, opts.watched);
      if (ev) {
        if (res.firstEventMs === null) res.firstEventMs = at - t0;
        res.events.push(ev);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      clearTimeout(hard);
      finish("erreur de connexion WebSocket (proxy ou pare-feu possible)");
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      clearTimeout(hard);
      finish(res.connected ? null : "connexion fermée avant ouverture");
    });
  });
}
