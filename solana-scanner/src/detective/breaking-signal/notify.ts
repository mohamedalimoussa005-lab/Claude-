/**
 * Notifications. Telegram is used only when a bot token + chat id are in the environment AND sending is explicitly
 * authorized (BREAKING_SIGNAL_TELEGRAM_SEND=yes). Otherwise every message goes to a simulated outbox. The token is never
 * written to a log, a report or an error message (it is part of the Telegram URL, so errors are redacted).
 */

import type { TelegramSettings } from "./config.ts";
import { NOT_ADVICE } from "./types.ts";
import type { Alert, BreakingResult, DetectiveBrief, Homonym, OnchainQuick, Verification } from "./types.ts";

export interface SendOutcome {
  mode: "simulation" | "live";
  ok: boolean;
  at: number;
  error: string | null;
  /** Telegram message date (ms) when known: lets us measure the delivery leg. */
  telegramDate: number | null;
}
export interface Notifier {
  readonly mode: "simulation" | "live";
  readonly reason: string;
  send(text: string): Promise<SendOutcome>;
}

export class SimulatedNotifier implements Notifier {
  readonly mode = "simulation" as const;
  readonly reason: string;
  readonly outbox: { at: number; text: string }[] = [];
  private readonly now: () => number;
  constructor(reason: string, now: () => number = Date.now) {
    this.reason = reason;
    this.now = now;
  }
  async send(text: string): Promise<SendOutcome> {
    const at = this.now();
    this.outbox.push({ at, text });
    return { mode: "simulation", ok: true, at, error: null, telegramDate: null };
  }
}

export const redact = (s: string, secret: string | null): string => {
  let out = secret ? s.split(secret).join("[REDACTED]") : s;
  out = out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot[REDACTED]").replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[REDACTED]");
  return out;
};

export type TgFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export class TelegramNotifier implements Notifier {
  readonly mode = "live" as const;
  readonly reason = "Telegram configuré et envoi autorisé";
  private readonly s: TelegramSettings;
  private readonly fetchImpl: TgFetch;
  private readonly now: () => number;
  constructor(s: TelegramSettings, fetchImpl: TgFetch, now: () => number = Date.now) {
    if (!s.sendAuthorized || !s.token || !s.chatId) throw new Error("envoi Telegram non autorisé");
    this.s = s;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }
  async send(text: string): Promise<SendOutcome> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await this.fetchImpl(`https://api.telegram.org/bot${this.s.token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: this.s.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }), signal: ctl.signal });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { date?: number } };
      const at = this.now();
      if (r.status !== 200 || body.ok !== true) return { mode: "live", ok: false, at, error: redact(`Telegram HTTP ${r.status}: ${body.description ?? "réponse inattendue"}`, this.s.token), telegramDate: null };
      return { mode: "live", ok: true, at, error: null, telegramDate: typeof body.result?.date === "number" ? body.result.date * 1000 : null };
    } catch (e) {
      return { mode: "live", ok: false, at: this.now(), error: redact(e instanceof Error ? e.message : String(e), this.s.token), telegramDate: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createNotifier(s: TelegramSettings, fetchImpl: TgFetch, now: () => number = Date.now): Notifier {
  if (s.sendAuthorized) return new TelegramNotifier(s, fetchImpl, now);
  const reason = !s.token || !s.chatId ? "Telegram non configuré (jeton ou identifiant de conversation absent)" : !s.configured ? "jeton Telegram au format invalide" : "envoi non autorisé (BREAKING_SIGNAL_TELEGRAM_SEND=yes absent)";
  return new SimulatedNotifier(`${reason}: messages écrits dans la boîte d'envoi simulée, rien n'est envoyé`, now);
}

const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const usd = (n: number | null) => (n === null ? "inconnue" : `${Math.round(n).toLocaleString("fr-FR").replace(/\s/g, " ")} $`);
const BADGE: Record<Verification["level"], string> = { CONFIRMÉ: "CONFIRMÉ", PROBABLE: "PROBABLE", "NON VÉRIFIÉ": "NON VÉRIFIÉ" };

export function formatAlert1(r: Pick<BreakingResult, "event" | "extraction" | "verification" | "onchain" | "homonyms" | "times">, accountLabel: string | null, detectiveFollows: boolean): string {
  const { event: e, verification: v, extraction: x, onchain: o } = r;
  const sim = e.provenance === "simulation" ? "[SIMULATION — événement fictif] " : e.provenance === "file" ? "[fichier local] " : "";
  const L: string[] = [];
  L.push(`${sim}${detectiveFollows ? "ALERTE 1/2" : "ALERTE"} — ${BADGE[v.level]}`);
  L.push(`Compte: ${accountLabel ?? "inconnu"} (@${e.handle}, id ${e.authorId})`);
  L.push(`Publié: ${utc(e.createdAt)} · détecté: ${utc(r.times.received)} (+${((r.times.received - e.createdAt) / 1000).toFixed(1)} s)`);
  L.push(`Lien original: ${e.url}`);
  L.push(`Texte: « ${e.text.replace(/\s+/g, " ").slice(0, 280)} »`);
  if (v.officialAddress) {
    L.push(`Adresse annoncée (${v.addressSource === "post" ? "dans le post" : "page officielle"}): ${v.officialAddress}`);
    if (o) L.push(`Vérification rapide on-chain: ${o.state === "valid_mint" ? `mint SPL valide, autorité de mint ${o.mintAuthority === null ? "révoquée" : o.mintAuthority === "UNKNOWN" ? "inconnue" : "ACTIVE"}, autorité de gel ${o.freezeAuthority === null ? "révoquée" : o.freezeAuthority === "UNKNOWN" ? "inconnue" : "ACTIVE"}, ${o.pools.length} pool(s) DEX Screener${o.pools[0] ? ` (liquidité déclarée ${usd(o.pools[0].liquidityUsd)})` : ""}` : `${o.state}${o.reason ? ` — ${o.reason}` : ""}`}`);
    else L.push("Vérification rapide on-chain: INCONNUE (délai dépassé ou indisponible)");
  } else {
    L.push("Adresse de contrat: AUCUNE établie par le post. Aucun token n'est annoncé.");
    if (x.entities.length || x.tickers.length) L.push(`Sujets cités: ${[...x.tickers.map((t) => `$${t}`), ...x.entities].slice(0, 6).join(", ")}`);
  }
  if (r.homonyms.length) L.push(`Attention: ${r.homonyms.length} token(s) Solana portent un nom cité (ex. ${r.homonyms.slice(0, 3).map((h) => `${h.symbol ?? "?"} ${h.mint.slice(0, 6)}…`).join(", ")}). Leur nom ne prouve AUCUN lien avec l'annonce: seul l'adresse annoncée compte.`);
  L.push("Critères: " + v.criteria.map((c) => `${c.id} ${c.ok === true ? "oui" : c.ok === false ? "NON" : "inconnu"}`).join(" · "));
  for (const n of v.notes) L.push(`Note: ${n}`);
  L.push(detectiveFollows ? "Enquête DETECTIVE en cours: résultat dans le message 2/2." : "Aucune enquête lancée (pas d'adresse exploitable).");
  L.push(NOT_ADVICE);
  return L.join("\n");
}

export function formatAlert2(r: Pick<BreakingResult, "event" | "verification" | "times">, d: DetectiveBrief): string {
  const sim = r.event.provenance === "simulation" ? "[SIMULATION — événement fictif] " : "";
  const L = [`${sim}ALERTE 2/2 — Enquête DETECTIVE (mode ${d.mode}) — ${r.verification.level}`, `Token: ${d.mint}`, `Post: ${r.event.url}`];
  if (d.status !== "done") L.push(`Enquête ${d.status === "failed" ? "ÉCHOUÉE" : "NON EXÉCUTÉE"}: ${d.reason ?? "raison inconnue"}`);
  else {
    L.push(`${d.calls} appel(s) RPC en ${(d.elapsedMs / 1000).toFixed(0)} s; limites: ${d.limitsReached.length ? d.limitsReached.join(" ; ").slice(0, 300) : "aucune"}`);
    for (const f of d.findings.slice(0, 8)) L.push(`[${f.level}] ${f.text.slice(0, 260)}`);
  }
  if (r.times.notified1) L.push(`Délai alerte 1 → fin d'enquête: ${(((r.times.detectiveDone ?? r.times.notified1) - r.times.notified1) / 1000).toFixed(0)} s`);
  L.push(NOT_ADVICE);
  return L.join("\n");
}

export type { Alert, Homonym, OnchainQuick };
