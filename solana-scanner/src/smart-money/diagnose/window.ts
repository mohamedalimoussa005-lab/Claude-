import type { HistoryTx } from "../../history/types.ts";
import type { HistoryCache } from "../../history/cache.ts";
import type { WalletReport } from "../ingest/report.ts";
import type { TxRef, WindowInfo } from "./types.ts";

export const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const ref = (t: { signature: string; slot: number | null; time: number | null }): TxRef => ({ signature: t.signature, slot: t.slot, time: t.time, date: iso(t.time) });

export function describeWindow(txs: HistoryTx[], report: WalletReport | null, origin: ReturnType<HistoryCache["getOrigin"]> | undefined, writtenAt: number | null): WindowInfo {
  const timed = txs.filter((t) => t.time !== null).sort((a, b) => (a.time as number) - (b.time as number) || (a.slot ?? 0) - (b.slot ?? 0));
  const oldest = timed[0] ? ref(timed[0]) : null;
  const newest = timed.length ? ref(timed[timed.length - 1]) : null;
  const spanMs = oldest && newest ? (newest.time as number) - (oldest.time as number) : null;
  const spanDays = spanMs === null ? null : spanMs / 86_400_000;
  const h = report?.history ?? null;
  const reportWindow = h ? { oldest: iso(h.oldestTime), newest: iso(h.newestTime), complete: h.complete, stopReason: h.stopReason } : null;
  const originKnown = !!origin && !origin.empty && origin.firstSeen !== null;
  const absent: string[] = [];
  if (txs.length === 0) absent.push("Aucune transaction en cache pour ce wallet.");
  if (!reportWindow) absent.push("Pas de rapport enregistré (--save) : l'état de complétude de la collecte est INCONNU, traité comme incomplet.");
  else if (!reportWindow.complete) absent.push(`Avant ${oldest?.date ?? "?"} : AUCUNE donnée — l'historique a été arrêté (${reportWindow.stopReason}) avant son début.`);
  if (!originKnown) absent.push("Date de la toute première transaction du wallet : INCONNUE (origine non établie).");
  if (writtenAt !== null && newest?.time != null && writtenAt > newest.time) absent.push(`Après ${iso(writtenAt)} (dernière collecte) : transactions éventuelles non couvertes.`);
  if (timed.length < txs.length) absent.push(`${txs.length - timed.length} transaction(s) sans heure de bloc : exclues de la fenêtre.`);
  const matches = reportWindow && oldest && newest ? reportWindow.oldest === oldest.date && reportWindow.newest === newest.date : null;
  if (matches === false) absent.push("Le cache ne correspond pas exactement au dernier rapport enregistré (cache enrichi par d'autres collectes, ou rapport plus ancien).");
  return {
    status: txs.length === 0 ? "impossible" : reportWindow ? "ok" : "partial",
    reason: txs.length === 0 ? "aucune transaction en cache pour ce wallet" : reportWindow ? undefined : "pas de rapport enregistré",
    txCount: txs.length,
    withoutTime: txs.length - timed.length,
    oldest,
    newest,
    spanDays,
    txPerDay: spanDays && spanDays > 0 ? timed.length / spanDays : null,
    originKnown,
    originDate: originKnown ? iso(origin!.firstSeen) : null,
    reportWindow,
    matchesReport: matches,
    absent,
  };
}
