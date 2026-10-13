/**
 * Telegram setup helpers (pure + injected fetch). The bot token is a secret: it is read from a hidden prompt or from the
 * environment — never from a command-line argument — written only to a git-ignored .env file (mode 600), and never printed.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { redact } from "./notify.ts";
import type { TgFetch } from "./notify.ts";

export const ENV_FILE = ".env.breaking";
export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Sets/replaces keys while keeping every other line. */
export function mergeEnvText(existing: string, updates: Record<string, string>): string {
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split(/\r?\n/);
  const done = new Set<string>();
  const out = lines.map((l) => {
    const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
    if (m && m[1]! in updates) {
      done.add(m[1]!);
      return `${m[1]}=${updates[m[1]!]}`;
    }
    return l;
  });
  for (const [k, v] of Object.entries(updates)) if (!done.has(k)) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

export function writeEnvKeys(path: string, updates: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, mergeEnvText(existing, updates), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Loads KEY=VALUE pairs into `env` WITHOUT overriding variables that are already set. Returns the key names loaded (never values). */
export function loadEnvFile(path: string, env: Record<string, string | undefined>): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}

async function call(f: TgFetch, token: string, method: string, body: unknown = {}): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; error: string | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await f(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const ok = r.status === 200 && json.ok === true;
    return { ok, status: r.status, json, error: ok ? null : redact(`Telegram HTTP ${r.status}: ${String(json.description ?? "réponse inattendue")}`, token) };
  } catch (e) {
    return { ok: false, status: 0, json: {}, error: redact(e instanceof Error ? e.message : String(e), token) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getMe(f: TgFetch, token: string): Promise<{ ok: boolean; username: string | null; isBot: boolean; error: string | null }> {
  const r = await call(f, token, "getMe");
  const res = (r.json.result ?? {}) as { username?: string; is_bot?: boolean };
  return { ok: r.ok && res.is_bot === true, username: res.username ?? null, isBot: res.is_bot === true, error: r.ok ? null : r.error };
}

export interface ChatCandidate {
  id: string;
  type: string;
  label: string;
  lastText: string | null;
  lastDate: number;
}

export function chatsFromUpdates(json: unknown): ChatCandidate[] {
  const list = Array.isArray((json as { result?: unknown })?.result) ? ((json as { result: unknown[] }).result) : [];
  const by = new Map<string, ChatCandidate>();
  for (const u of list as Record<string, unknown>[]) {
    const m = (u.message ?? u.edited_message ?? u.channel_post) as { chat?: Record<string, unknown>; text?: string; date?: number } | undefined;
    const c = m?.chat;
    if (!c || (typeof c.id !== "number" && typeof c.id !== "string")) continue;
    const id = String(c.id);
    const label = [c.first_name, c.last_name].filter((x) => typeof x === "string").join(" ") || (typeof c.title === "string" ? c.title : "") || (typeof c.username === "string" ? `@${c.username}` : "sans nom");
    const date = typeof m?.date === "number" ? m.date : 0;
    const prev = by.get(id);
    if (!prev || date >= prev.lastDate) by.set(id, { id, type: String(c.type ?? "?"), label, lastText: typeof m?.text === "string" ? m.text.slice(0, 40) : null, lastDate: date });
  }
  return [...by.values()].sort((a, b) => b.lastDate - a.lastDate);
}

export type ChatLookup = { state: "found"; chat: ChatCandidate } | { state: "ambiguous"; chats: ChatCandidate[] } | { state: "none"; hint: string } | { state: "error"; error: string };

/** getUpdates → the single private chat that wrote to the bot. Several chats → the user must choose. Never guesses. */
export async function findChat(f: TgFetch, token: string): Promise<ChatLookup> {
  const r = await call(f, token, "getUpdates", { limit: 100, allowed_updates: ["message"] });
  if (!r.ok) {
    const hint = r.status === 409 ? " (un webhook est actif sur ce bot: getUpdates est indisponible tant qu'il n'est pas supprimé)" : r.status === 401 ? " (jeton refusé)" : "";
    return { state: "error", error: `${r.error ?? "erreur inconnue"}${hint}` };
  }
  const chats = chatsFromUpdates(r.json);
  const priv = chats.filter((c) => c.type === "private");
  if (priv.length === 1 && chats.length === 1) return { state: "found", chat: priv[0]! };
  if (chats.length === 0) return { state: "none", hint: "aucun message reçu par le bot: ouvrez le bot dans Telegram, envoyez /start, puis relancez" };
  return { state: "ambiguous", chats };
}

export function testNotification(now: number, mode: "simulation" | "sent"): string {
  const t = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    mode === "simulation" ? "[SIMULATION] Test de configuration — DETECTIVE Breaking Signal" : "[TEST DE CONFIGURATION, ENVOYÉ APRÈS VOTRE CONFIRMATION] DETECTIVE Breaking Signal",
    `Heure: ${t}`,
    "Ceci est un message de test: ce n'est PAS une alerte, aucun événement réel n'a été détecté, aucun token n'est cité.",
    "Aucune connexion à X n'est active en phase 0 et aucun ordre n'est passé.",
  ].join("\n");
}

export interface ConfigCheck {
  lines: { ok: boolean | null; text: string }[];
  ready: boolean;
}

export function checkConfigOffline(env: Record<string, string | undefined>): ConfigCheck {
  const token = env.BREAKING_SIGNAL_TELEGRAM_TOKEN?.trim();
  const chat = env.BREAKING_SIGNAL_TELEGRAM_CHAT_ID?.trim();
  const send = env.BREAKING_SIGNAL_TELEGRAM_SEND;
  const lines: ConfigCheck["lines"] = [
    { ok: !!token && TOKEN_RE.test(token), text: !token ? "BREAKING_SIGNAL_TELEGRAM_TOKEN: absent" : TOKEN_RE.test(token) ? "BREAKING_SIGNAL_TELEGRAM_TOKEN: présent, format valide (valeur masquée)" : "BREAKING_SIGNAL_TELEGRAM_TOKEN: présent mais format invalide (valeur masquée)" },
    { ok: !!chat && /^-?\d+$/.test(chat), text: !chat ? "BREAKING_SIGNAL_TELEGRAM_CHAT_ID: absent" : /^-?\d+$/.test(chat) ? "BREAKING_SIGNAL_TELEGRAM_CHAT_ID: présent, format valide" : "BREAKING_SIGNAL_TELEGRAM_CHAT_ID: format invalide (nombre attendu)" },
    { ok: null, text: send === "yes" ? "BREAKING_SIGNAL_TELEGRAM_SEND=yes: envoi réel AUTORISÉ" : "BREAKING_SIGNAL_TELEGRAM_SEND non défini à « yes »: les notifications restent en SIMULATION (comportement voulu tant que vous n'avez pas confirmé)" },
  ];
  return { lines, ready: lines[0]!.ok === true && lines[1]!.ok === true };
}
