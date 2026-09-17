// The PRIVILEGED contract — deliberately kept in its own file/interface,
// separate from bookingService.ts, so the two privilege levels never blur:
//
//   BookingService      → safe for the public site, no auth
//   AdminBookingService → full customer records, MUST require the owner
//                         to be authenticated once a real backend exists
//
// Nothing in src/pages or src/components should import this from a
// public-facing page. Only the /admin shell (src/pages/Admin.tsx) may use
// it. When a real backend lands, its implementation must run behind auth
// (Supabase RLS + an authenticated session, or a server-side function) —
// see docs/BOOKING_BACKEND.md §Security. The demo below has none, because
// there is no real customer data behind it yet.

import type { BookingConfirmation } from "./types";
import { getSharedDemoInstance } from "./bookingService";

export interface AdminBookingService {
  listBookingsForDate(dateISO: string): Promise<BookingConfirmation[]>;
}

export function getAdminBookingService(): AdminBookingService {
  // Demo only: reuses the same in-memory store as the public DemoBookingService
  // so a booking made through /reservation shows up here immediately. A real
  // implementation would call an authenticated Supabase query instead.
  return getSharedDemoInstance();
}
