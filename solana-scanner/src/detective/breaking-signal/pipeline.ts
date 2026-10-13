/**
 * Event → extraction → verification → ALERT 1 (never waits for DETECTIVE) → DETECTIVE → ALERT 2, with every stage timed.
 * Each delay is measured; none is promised.
 */

import { extractFromPost } from "./extract.ts";
import type { BreakingConfig } from "./config.ts";
import { formatAlert1, formatAlert2 } from "./notify.ts";
import type { Notifier } from "./notify.ts";
import { verifyPost } from "./verify.ts";
import type { PageFetcher } from "./verify.ts";
import type { Alert, BreakingResult, DetectiveBrief, Homonym, OnchainQuick, PostEvent, StageTimes } from "./types.ts";

export interface PipelineDeps {
  cfg: BreakingConfig;
  notifier: Notifier;
  now?: () => number;
  checkMint?: (mint: string) => Promise<OnchainQuick | null>;
  fetchPage?: PageFetcher;
  findHomonyms?: (names: string[], exclude: string | null) => Promise<Homonym[]>;
  detective?: (mint: string) => Promise<DetectiveBrief>;
  /** Event ids already handled (shared across calls to avoid repeated alerts). */
  seen?: Set<string>;
}

async function timebox<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => (t = setTimeout(() => r(null), ms)))]);
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

export function delaysOf(t: StageTimes): Record<string, number | null> {
  const d = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? null : b - a);
  return {
    "publication → réception": d(t.published, t.received),
    "réception → extraction": d(t.received, t.extracted),
    "extraction → vérification": d(t.extracted, t.verified),
    "vérification → alerte 1": d(t.verified, t.notified1),
    "réception → alerte 1": d(t.received, t.notified1),
    "publication → alerte 1": d(t.published, t.notified1),
    "alerte 1 → départ enquête": d(t.notified1, t.detectiveStarted),
    "enquête": d(t.detectiveStarted, t.detectiveDone),
    "fin enquête → alerte 2": d(t.detectiveDone, t.notified2),
    "réception → alerte 2": d(t.received, t.notified2),
  };
}

export async function handleEvent(event: PostEvent, deps: PipelineDeps): Promise<BreakingResult> {
  const now = deps.now ?? Date.now;
  const times: StageTimes = { published: event.createdAt, received: now() };
  const seen = deps.seen ?? new Set<string>();
  const empty = { alerts: [] as Alert[], detective: null, homonyms: [] as Homonym[], onchain: null };
  if (seen.has(event.id)) {
    const extraction = extractFromPost(event, deps.cfg);
    return { event, extraction, verification: { level: "NON VÉRIFIÉ", criteria: [], officialAddress: null, addressSource: null, notes: ["événement déjà traité: aucune alerte répétée"] }, times, delays: delaysOf(times), duplicate: true, ...empty };
  }
  seen.add(event.id);

  const extraction = extractFromPost(event, deps.cfg);
  times.extracted = now();

  // everything that precedes alert 1 is time-boxed: a slow RPC must not delay the notification
  const box = deps.cfg.fastCheckMs;
  const checkMint = deps.checkMint ? (m: string) => timebox(deps.checkMint!(m), box) : undefined;
  const fetchPage = deps.fetchPage ? (u: string) => timebox(deps.fetchPage!(u), box).then((x) => x ?? null) : undefined;
  const { verification, onchain } = await verifyPost({ event, extraction, accounts: deps.cfg.accounts, checkMint, fetchPage });
  const names = [...new Set([...extraction.tickers.map((t) => t.toLowerCase()), ...extraction.entities.filter((p) => p.length >= 4).slice(0, 2)])].slice(0, 3);
  const homonyms = deps.findHomonyms && names.length ? ((await timebox(deps.findHomonyms(names, verification.officialAddress), box)) ?? []) : [];
  times.verified = now();

  const account = deps.cfg.accounts.find((a) => a.userId === event.authorId)?.label ?? null;
  const willInvestigate = !!deps.detective && !!verification.officialAddress && onchain?.state !== "not_a_mint" && onchain?.state !== "not_found";
  const alerts: Alert[] = [];
  const text1 = formatAlert1({ event, extraction, verification, onchain, homonyms, times }, account, willInvestigate);
  const sent1 = await deps.notifier.send(text1);
  times.notified1 = sent1.at;
  alerts.push({ stage: 1, text: text1, level: verification.level, provenance: event.provenance });

  let detective: DetectiveBrief | null = null;
  if (willInvestigate) {
    times.detectiveStarted = now();
    try {
      detective = await deps.detective!(verification.officialAddress!);
    } catch (e) {
      detective = { mint: verification.officialAddress!, mode: "rapide", calls: 0, elapsedMs: 0, limitsReached: [], status: "failed", reason: e instanceof Error ? e.message : String(e), findings: [] };
    }
    times.detectiveDone = now();
    const text2 = formatAlert2({ event, verification, times }, detective);
    const sent2 = await deps.notifier.send(text2);
    times.notified2 = sent2.at;
    alerts.push({ stage: 2, text: text2, level: verification.level, provenance: event.provenance });
  }
  return { event, extraction, verification, onchain, homonyms, alerts, detective, times, delays: delaysOf(times), duplicate: false };
}
