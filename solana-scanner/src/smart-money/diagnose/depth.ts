import type { PnlResult } from "../pnl/types.ts";
import type { DepthEstimate, OrphanGroup, WindowInfo } from "./types.ts";

const pct = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

/**
 * Which orphan tokens could a deeper history explain? A heuristic, not a fact: the missing purchase is assumed to be at
 * most a usual holding time (p75 of the positions that closed INSIDE the window) before the first orphan sale.
 */
export function estimateDepth(groups: OrphanGroup[], pnl: PnlResult, win: WindowInfo, targetTransactions: number): DepthEstimate {
  const holds = pnl.rounds.filter((r) => r.status !== "UNKNOWN").map((r) => r.holdSeconds / 3600);
  const caveats = ["Estimation heuristique : seules les positions fermées DANS la fenêtre servent d'échantillon, ce qui sous-estime les durées de détention longues."];
  const p = { p50: pct(holds, 0.5), p75: pct(holds, 0.75), p90: pct(holds, 0.9) };
  const of = groups.length;
  if (groups.length === 0) return { status: "ok", holdSamples: holds.length, holdHours: p, perGroup: [], extension: { targetTransactions, extraHours: null, plausiblyCovered: 0, of: 0 }, caveats: ["aucune vente sans achat connu : rien à étendre"] };
  if (holds.length < 5 || p.p75 === null) {
    return {
      status: "impossible",
      reason: `échantillon de durées de détention insuffisant (${holds.length} < 5 positions fermées dans la fenêtre)`,
      holdSamples: holds.length,
      holdHours: p,
      perGroup: groups.map((g) => ({ mint: g.mint, hoursSinceWindowStart: g.sales[0].hoursAfterWindowStart, extraHoursNeeded: null, verdict: "unknown" as const })),
      extension: { targetTransactions, extraHours: null, plausiblyCovered: null, of },
      caveats,
    };
  }
  const perGroup = groups.map((g) => {
    const since = g.sales[0].hoursAfterWindowStart;
    const extra = since === null ? null : Math.max(0, p.p75! - since);
    let verdict: DepthEstimate["perGroup"][number]["verdict"] = "unknown";
    if (extra !== null) verdict = g.category === "order_ambiguity" || extra === 0 ? "bought_inside_window_expected" : extra <= (p.p90 ?? p.p75!) ? "covered_by_modest_extension" : "beyond_usual_holding_time";
    return { mint: g.mint, hoursSinceWindowStart: since, extraHoursNeeded: extra, verdict };
  });
  // Extending to `targetTransactions` pushes the window back by (target − collected) / rate.
  const rate = win.txPerDay;
  const extraHours = rate && rate > 0 ? ((targetTransactions - win.txCount) / rate) * 24 : null;
  if (extraHours === null) caveats.push("Rythme d'activité inconnu : la profondeur gagnée par une extension ne peut pas être convertie en heures.");
  const covered = extraHours === null ? null : perGroup.filter((g) => g.extraHoursNeeded !== null && g.extraHoursNeeded > 0 && g.extraHoursNeeded <= extraHours).length;
  return { status: "ok", holdSamples: holds.length, holdHours: p, perGroup, extension: { targetTransactions, extraHours, plausiblyCovered: covered, of }, caveats };
}
