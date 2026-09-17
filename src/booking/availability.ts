// Pure date/slot arithmetic — no config, no I/O, no knowledge of demo vs
// real data. DemoBookingService (and, later, a Supabase-backed one) both
// build on these helpers so the slot-generation logic isn't duplicated or
// reinvented per backend.

import type { TimeSlot } from "./types";

export function combineDateAndTime(dateISO: string, time: string): Date {
  return new Date(`${dateISO}T${time}:00`);
}

export function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "2026-09-24" → "Jeudi 24 septembre" */
export function formatLongDateFR(dateISO: string): string {
  const d = combineDateAndTime(dateISO, "00:00");
  const label = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(d);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000);
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Every possible start time for a service within one open→close window, ignoring breaks/bookings/notice. */
export function generateSlotsForDay(params: {
  dateISO: string;
  openTime: string;
  closeTime: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
}): TimeSlot[] {
  const { dateISO, openTime, closeTime, durationMinutes, slotIntervalMinutes } = params;
  const open = combineDateAndTime(dateISO, openTime);
  const close = combineDateAndTime(dateISO, closeTime);

  const slots: TimeSlot[] = [];
  let cursor = open;
  while (true) {
    const end = addMinutes(cursor, durationMinutes);
    if (end > close) break;
    slots.push({ start: cursor.toISOString(), end: end.toISOString() });
    cursor = addMinutes(cursor, slotIntervalMinutes);
  }
  return slots;
}

/** Filters out any slot that overlaps a recurring daily break window. */
export function excludeBreaks(dateISO: string, slots: TimeSlot[], breaks: Array<{ start: string; end: string }>): TimeSlot[] {
  const breakRanges = breaks.map((b) => ({
    start: combineDateAndTime(dateISO, b.start),
    end: combineDateAndTime(dateISO, b.end),
  }));
  return slots.filter((slot) => {
    const s = new Date(slot.start);
    const e = new Date(slot.end);
    return !breakRanges.some((b) => rangesOverlap(s, e, b.start, b.end));
  });
}

/** Filters out any slot that overlaps an already-booked (or otherwise blocked) range. */
export function excludeBusy(slots: TimeSlot[], busyRanges: Array<{ start: string; end: string }>): TimeSlot[] {
  const busy = busyRanges.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  return slots.filter((slot) => {
    const s = new Date(slot.start);
    const e = new Date(slot.end);
    return !busy.some((b) => rangesOverlap(s, e, b.start, b.end));
  });
}

/** Filters out slots that start too soon (or in the past) relative to `now`. */
export function excludeTooSoon(slots: TimeSlot[], now: Date, minNoticeHours: number): TimeSlot[] {
  const earliest = new Date(now.getTime() + minNoticeHours * 3_600_000);
  return slots.filter((slot) => new Date(slot.start) >= earliest);
}
