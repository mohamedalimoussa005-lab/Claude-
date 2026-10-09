/** Plain-text rendering of ledger entries (French labels, as in the DETECTIVE reports). */

import type { Evidence } from "./types.ts";
import { STATUS_LABEL_FR } from "./types.ts";

export function formatEvidence(e: Evidence): string {
  const anchor = [e.signature ? `sig ${e.signature}` : null, e.slot !== null ? `slot ${e.slot}` : null, e.url ? e.url : null].filter(Boolean).join(" · ");
  const lines = [`[${STATUS_LABEL_FR[e.status]}] ${e.summary}`, `  ${e.source} · ${e.type} · observé ${e.observedAt}${e.eventTime ? ` (événement ${e.eventTime})` : ""}${anchor ? ` · ${anchor}` : ""}`];
  if (e.limits.length > 0) lines.push(`  limites: ${e.limits.join(" | ")}`);
  if (e.missing.length > 0) lines.push(`  manquant: ${e.missing.join(" | ")}`);
  return lines.join("\n");
}
