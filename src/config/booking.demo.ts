// ============================================================================
// DEMO CONFIGURATION — NOT REAL LS BARBER DATA
// ============================================================================
// Every business-specific rule the booking system needs (services, prices,
// durations, opening hours, breaks, booking-window rules) lives HERE and
// only here. No other file should hardcode a service name, a price, an
// opening hour, etc. — components and the demo service layer both read
// from this file.
//
// When LS Barber's real information is available, this file is the ONLY
// place that needs to change to go live (see docs/CLIENT_ACTIVATION_CHECKLIST.md).
// The booking UI and the BookingService interface do not change.
// ============================================================================

import type { Service } from "../booking/types";

export const DEMO_SERVICES: Service[] = [
  { id: "coupe-homme", name: "Coupe homme", durationMinutes: 30, price: 25, detail: "Ciseaux, tondeuse, dégradé sur mesure" },
  { id: "taille-barbe", name: "Taille de barbe", durationMinutes: 20, price: 15, detail: "Ligne nette, rasoir, finitions à chaud" },
  { id: "coupe-barbe", name: "Coupe + Barbe", durationMinutes: 45, price: 35, detail: "Le rituel complet" },
  { id: "coupe-enfant", name: "Coupe enfant", durationMinutes: 25, price: 18, detail: "Même précision, même exigence" },
];

/** 0 = Sunday … 6 = Saturday, matching Date#getDay(). Missing day = closed. */
export const DEMO_BUSINESS_HOURS: Record<number, { open: string; close: string }> = {
  2: { open: "09:00", close: "19:00" }, // Tuesday
  3: { open: "09:00", close: "19:00" }, // Wednesday
  4: { open: "09:00", close: "19:00" }, // Thursday
  5: { open: "09:00", close: "19:00" }, // Friday
  6: { open: "09:00", close: "18:00" }, // Saturday
  // Sunday (0) and Monday (1): closed.
};

/** Daily recurring breaks, applied on every open day (e.g. lunch). */
export const DEMO_DAILY_BREAKS: Array<{ start: string; end: string }> = [{ start: "12:30", end: "13:30" }];

export const DEMO_BOOKING_RULES = {
  /** Granularity of bookable start times. */
  slotIntervalMinutes: 30,
  /** Can't book a slot starting less than this many hours from now. */
  minNoticeHours: 2,
  /** Furthest a customer can book ahead. */
  maxAdvanceDays: 21,
};

/**
 * Fake pre-existing bookings, purely so the demo can visibly prove that
 * already-taken slots are excluded from availability. Regenerated relative
 * to "today" on module load so the demo never looks stale. Cleared/extended
 * in-memory by DemoBookingService as new demo bookings are made.
 */
export function seedDemoBookings(): Array<{ serviceId: string; date: string; time: string }> {
  const toISODate = (d: Date) => d.toISOString().slice(0, 10);
  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  };
  return [
    { serviceId: "coupe-homme", date: toISODate(inDays(2)), time: "10:00" },
    { serviceId: "coupe-barbe", date: toISODate(inDays(2)), time: "15:30" },
    { serviceId: "taille-barbe", date: toISODate(inDays(4)), time: "11:30" },
  ];
}
