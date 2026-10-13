/**
 * Configuration. Secrets come ONLY from the environment (never from files tracked by git, never logged):
 *   BREAKING_SIGNAL_TELEGRAM_TOKEN, BREAKING_SIGNAL_TELEGRAM_CHAT_ID, BREAKING_SIGNAL_TELEGRAM_SEND=yes (explicit send authorization)
 * The watch list is a JSON file (numeric X user ids). Without an official X connection nothing is "monitored".
 */

import { readFileSync } from "node:fs";
import type { WatchedAccount } from "./types.ts";

export interface BreakingConfig {
  accounts: WatchedAccount[];
  /** Budget for the quick on-chain check that precedes the first alert (ms). */
  fastCheckMs: number;
  fastCheckCalls: number;
  /** Words that make a post "mention a launch" (descriptive only). */
  launchWords: string[];
  /** Names/tickers watched on the free PumpPortal stream (matches are always unofficial until an announcement says otherwise). */
  watchedNames: string[];
}

export const DEFAULT_CONFIG: BreakingConfig = {
  accounts: [],
  fastCheckMs: 6000,
  fastCheckCalls: 6,
  launchWords: ["launch", "launched", "launching", "new coin", "new token", "meme coin", "memecoin", "meme", "official", "contract", "ca:", "airdrop", "is here"],
  watchedNames: ["trump", "melania"],
};

const NUMERIC_ID = /^\d{3,20}$/;

export function validateAccounts(raw: unknown): { accounts: WatchedAccount[]; problems: string[] } {
  const problems: string[] = [];
  const accounts: WatchedAccount[] = [];
  const list = Array.isArray((raw as { accounts?: unknown })?.accounts) ? ((raw as { accounts: unknown[] }).accounts) : [];
  for (const a of list as Record<string, unknown>[]) {
    const userId = typeof a?.userId === "string" ? a.userId : "";
    if (!NUMERIC_ID.test(userId)) {
      problems.push(`compte « ${String(a?.handle ?? "?")} » ignoré: userId numérique manquant ou invalide (un pseudo n'est pas une identité)`);
      continue;
    }
    const domains = Array.isArray(a.officialDomains) ? (a.officialDomains as unknown[]).filter((d): d is string => typeof d === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)).map((d) => d.toLowerCase()) : [];
    accounts.push({ userId, handle: String(a.handle ?? "").replace(/^@/, ""), label: String(a.label ?? a.handle ?? userId), officialDomains: domains });
  }
  return { accounts, problems };
}

export function loadConfig(path: string | undefined): { config: BreakingConfig; problems: string[] } {
  if (!path) return { config: { ...DEFAULT_CONFIG }, problems: ["aucune liste blanche chargée (--config absent)"] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { accounts, problems } = validateAccounts(raw);
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
    return { config: { ...DEFAULT_CONFIG, accounts, fastCheckMs: num(raw.fastCheckMs, DEFAULT_CONFIG.fastCheckMs), fastCheckCalls: num(raw.fastCheckCalls, DEFAULT_CONFIG.fastCheckCalls), watchedNames: Array.isArray(raw.watchedNames) ? (raw.watchedNames as unknown[]).filter((x): x is string => typeof x === "string") : DEFAULT_CONFIG.watchedNames }, problems };
  } catch (e) {
    return { config: { ...DEFAULT_CONFIG }, problems: [`liste blanche illisible: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export interface TelegramSettings {
  configured: boolean;
  /** True only with token + chat id + explicit BREAKING_SIGNAL_TELEGRAM_SEND=yes. */
  sendAuthorized: boolean;
  token: string | null;
  chatId: string | null;
}

export function telegramFromEnv(env: Record<string, string | undefined>): TelegramSettings {
  const token = env.BREAKING_SIGNAL_TELEGRAM_TOKEN?.trim() || null;
  const chatId = env.BREAKING_SIGNAL_TELEGRAM_CHAT_ID?.trim() || null;
  const configured = !!token && !!chatId && /^\d+:[A-Za-z0-9_-]{20,}$/.test(token);
  return { configured, sendAuthorized: configured && env.BREAKING_SIGNAL_TELEGRAM_SEND === "yes", token, chatId };
}
