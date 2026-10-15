/** Persistent state of the watcher: articles already seen, stories already alerted (with their level), alert timestamps. Atomic writes. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Article } from "../../social-radar/types.ts";
import type { NewsLevel } from "./verifyNews.ts";

export interface AlertRecord {
  anchorId: string;
  articleIds: string[];
  level: NewsLevel;
  stage1At: number;
  upgrades: number;
}

export interface WatchState {
  version: 1;
  createdAt: number;
  /** articleId → time we first saw it (our detection time). */
  seen: Record<string, number>;
  alerts: AlertRecord[];
  /** Relevant articles of the last hours, kept so that corroboration survives a restart. */
  window: Article[];
  alertTimes: number[];
  lastDegradedNoticeAt: number | null;
  baselineDone: boolean;
}

export const emptyState = (now: number): WatchState => ({ version: 1, createdAt: now, seen: {}, alerts: [], window: [], alertTimes: [], lastDegradedNoticeAt: null, baselineDone: false });

export class StateStore {
  state: WatchState;
  private readonly path: string | null;
  private readonly now: () => number;
  constructor(path: string | null, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    this.state = emptyState(now());
    if (path && existsSync(path)) {
      try {
        const s = JSON.parse(readFileSync(path, "utf8")) as WatchState;
        if (s.version === 1 && typeof s.seen === "object") this.state = { ...emptyState(now()), ...s };
      } catch {
        // a corrupt file must not crash the watcher: start clean (the baseline pass prevents an alert flood)
        this.state = emptyState(now());
      }
    }
  }
  prune(maxAgeMs = 7 * 86_400_000, maxSeen = 20_000, windowMs = 6 * 3_600_000): void {
    const t = this.now();
    const s = this.state;
    const entries = Object.entries(s.seen).filter(([, at]) => t - at <= maxAgeMs).sort((a, b) => b[1] - a[1]).slice(0, maxSeen);
    s.seen = Object.fromEntries(entries);
    s.window = s.window.filter((a) => t - (a.publishedAt ?? t) <= windowMs);
    s.alerts = s.alerts.filter((a) => t - a.stage1At <= maxAgeMs);
    s.alertTimes = s.alertTimes.filter((x) => t - x <= 3_600_000);
  }
  save(): void {
    if (!this.path) return;
    this.prune();
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }
}
