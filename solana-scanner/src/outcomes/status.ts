/**
 * Collection health summary (no network): dataset size, recent captures,
 * decisions, checkpoint coverage and failures. Descriptive only.
 */

import { CHECKPOINTS, checkpointState } from "./tracker.ts";
import type { Observation } from "./tracker.ts";

const DECISIONS = ["MOMENTUM", "WATCH", "CAUTION", "AVOID", "NO SIGNAL"] as const;
const kb = (bytes: number | null) => (bytes === null ? "absent" : bytes < 1024 ? `${bytes} o` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} Ko` : `${(bytes / 1024 ** 2).toFixed(2)} Mo`);

export function formatStatus(obs: Observation[], now: number, datasetBytes: number | null, datasetPath: string): string {
  const out: string[] = [];
  out.push(`TOTAL OBSERVATIONS: ${obs.length}`);
  out.push(`NEW LAST 24H: ${obs.filter((o) => now - o.snapshot.capturedAt < 24 * 3_600_000).length}`);
  const captures = new Set(obs.map((o) => o.snapshot.capturedAt));
  out.push(`CAPTURES (scans distincts): ${captures.size}${captures.size ? ` · dernière ${new Date(Math.max(...captures)).toISOString()}` : ""}`);
  out.push("", "BY DECISION");
  for (const d of DECISIONS) out.push(`${d}: ${obs.filter((o) => o.snapshot.final.decision === d).length}`);
  out.push("", "CHECKPOINT COVERAGE (OK / dus)");
  let missed = 0;
  let errors = 0;
  let unavailable = 0;
  for (const { key, ms } of CHECKPOINTS) {
    const due = obs.filter((o) => now >= o.snapshot.capturedAt + ms);
    const by = (s: string) => due.filter((o) => o.outcomes[key]?.status === s).length;
    missed += by("MISSED");
    errors += by("PROVIDER_ERROR");
    unavailable += by("UNAVAILABLE");
    const pending = due.filter((o) => !o.outcomes[key]).length;
    out.push(`${key}: ${by("OK")}/${due.length}${due.length ? ` · MISSED ${by("MISSED")} · PROVIDER_ERROR ${by("PROVIDER_ERROR")} · UNAVAILABLE ${by("UNAVAILABLE")} · en attente ${pending}` : ""}`);
  }
  out.push("", `MISSED: ${missed}`, `PROVIDER ERRORS: ${errors}`, `UNAVAILABLE: ${unavailable}`);
  const incomplete = obs.filter((o) => CHECKPOINTS.some(({ key }) => checkpointState(o, key, now) !== "FINAL")).sort((a, b) => a.snapshot.capturedAt - b.snapshot.capturedAt);
  const oldest = incomplete[0];
  out.push(
    `OLDEST INCOMPLETE OBSERVATION: ${oldest ? `${oldest.snapshot.identity.symbol ?? oldest.snapshot.identity.mint} · T0 ${new Date(oldest.snapshot.capturedAt).toISOString()} (${((now - oldest.snapshot.capturedAt) / 3_600_000).toFixed(1)} h)` : "aucune"}`,
  );
  out.push(`INCOMPLETE OBSERVATIONS: ${incomplete.length}`);
  out.push(`DATASET SIZE: ${kb(datasetBytes)} (${datasetPath})`);
  return out.join("\n");
}
