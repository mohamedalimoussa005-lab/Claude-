// Domain types for the booking system. These describe the shape of data the
// UI works with regardless of what sits behind BookingService — demo today,
// a real backend (e.g. Supabase) later. Keep this file backend-agnostic:
// no Supabase types, no fetch/HTTP details here.

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  /** Price in EUR. May be demo data — see src/config/booking.demo.ts. */
  price: number;
  detail: string;
}

export interface TimeSlot {
  /** ISO 8601, e.g. "2026-09-24T15:30:00" (local time, no timezone math yet). */
  start: string;
  end: string;
}

export interface CustomerInfo {
  firstName: string;
  lastName: string;
  phone: string;
  /** Optional, per the brief. */
  email?: string;
}

export interface BookingRequest {
  serviceId: string;
  /** ISO date, e.g. "2026-09-24". */
  date: string;
  /** ISO time, e.g. "15:30". */
  time: string;
  customer: CustomerInfo;
}

export interface BookingConfirmation {
  id: string;
  service: Service;
  date: string;
  time: string;
  customer: CustomerInfo;
  createdAt: string;
  /**
   * Always true for now: no backend exists, so nothing was actually sent to
   * LS Barber. The UI must keep showing this to the visitor. Once a real
   * BookingService is wired in, this becomes false for real confirmations.
   */
  isDemo: true;
}
