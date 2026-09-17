// DEMO implementation of BookingService. Stores bookings in memory only
// (resets on page reload) — there is no backend. This is intentionally the
// ONLY file that touches the in-memory store; a future SupabaseBookingService
// would replace this file's internals but keep the same public shape.

import type { BookingService } from "./bookingService";
import type { BookingConfirmation, BookingRequest, Service, TimeSlot } from "./types";
import { DEMO_BOOKING_RULES, DEMO_BUSINESS_HOURS, DEMO_DAILY_BREAKS, DEMO_SERVICES, seedDemoBookings } from "../config/booking.demo";
import { addDays, combineDateAndTime, excludeBreaks, excludeBusy, excludeTooSoon, formatDateISO, generateSlotsForDay } from "./availability";

function simulateLatency(ms = 350): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findService(serviceId: string): Service {
  const service = DEMO_SERVICES.find((s) => s.id === serviceId);
  if (!service) throw new Error(`Service inconnu : ${serviceId}`);
  return service;
}

function openHoursFor(dateISO: string): { open: string; close: string } | null {
  const weekday = combineDateAndTime(dateISO, "00:00").getDay();
  return DEMO_BUSINESS_HOURS[weekday] ?? null;
}

export class DemoBookingService implements BookingService {
  /** In-memory bookings: seeded fakes + anything created during this session. */
  private bookings: BookingConfirmation[];

  constructor() {
    this.bookings = seedDemoBookings().map((seed) => {
      const service = findService(seed.serviceId);
      return {
        id: `seed-${seed.date}-${seed.time}`,
        service,
        date: seed.date,
        time: seed.time,
        customer: { firstName: "Client", lastName: "Existant", phone: "" },
        createdAt: new Date().toISOString(),
        isDemo: true as const,
      };
    });
  }

  private busyRangesFor(dateISO: string): Array<{ start: string; end: string }> {
    return this.bookings
      .filter((b) => b.date === dateISO)
      .map((b) => {
        const start = combineDateAndTime(b.date, b.time);
        const end = new Date(start.getTime() + b.service.durationMinutes * 60_000);
        return { start: start.toISOString(), end: end.toISOString() };
      });
  }

  private computeSlots(dateISO: string, service: Service): TimeSlot[] {
    const hours = openHoursFor(dateISO);
    if (!hours) return [];

    let slots = generateSlotsForDay({
      dateISO,
      openTime: hours.open,
      closeTime: hours.close,
      durationMinutes: service.durationMinutes,
      slotIntervalMinutes: DEMO_BOOKING_RULES.slotIntervalMinutes,
    });
    slots = excludeBreaks(dateISO, slots, DEMO_DAILY_BREAKS);
    slots = excludeBusy(slots, this.busyRangesFor(dateISO));
    slots = excludeTooSoon(slots, new Date(), DEMO_BOOKING_RULES.minNoticeHours);
    return slots;
  }

  async getServices(): Promise<Service[]> {
    await simulateLatency(150);
    return DEMO_SERVICES;
  }

  async getAvailableDates(serviceId: string): Promise<string[]> {
    await simulateLatency();
    const service = findService(serviceId);
    const today = new Date();
    const dates: string[] = [];
    for (let i = 0; i <= DEMO_BOOKING_RULES.maxAdvanceDays; i++) {
      const dateISO = formatDateISO(addDays(today, i));
      if (this.computeSlots(dateISO, service).length > 0) dates.push(dateISO);
    }
    return dates;
  }

  async getAvailableSlots(dateISO: string, serviceId: string): Promise<TimeSlot[]> {
    await simulateLatency();
    const service = findService(serviceId);
    return this.computeSlots(dateISO, service);
  }

  async createBooking(request: BookingRequest): Promise<BookingConfirmation> {
    await simulateLatency(500);
    const service = findService(request.serviceId);

    // Re-check the slot is still free — guards against a double-booking
    // race within the same demo session (e.g. two tabs picking the same
    // slot). A real backend enforces this with a database constraint
    // (see docs/BOOKING_BACKEND.md) rather than an in-memory recheck.
    const stillFree = this.computeSlots(request.date, service).some((slot) => {
      const start = combineDateAndTime(request.date, request.time);
      return new Date(slot.start).getTime() === start.getTime();
    });
    if (!stillFree) {
      throw new Error("Ce créneau vient d'être réservé. Merci d'en choisir un autre.");
    }

    const confirmation: BookingConfirmation = {
      id: crypto.randomUUID(),
      service,
      date: request.date,
      time: request.time,
      customer: request.customer,
      createdAt: new Date().toISOString(),
      isDemo: true,
    };
    this.bookings.push(confirmation);
    return confirmation;
  }

  /**
   * ADMIN-ONLY. Not part of the public BookingService contract — see
   * adminBookingService.ts. Returns full customer records for one date.
   * A real backend must gate the equivalent query behind owner
   * authentication (RLS / an authenticated server function); it must never
   * be reachable by the public site. See docs/BOOKING_BACKEND.md §Security.
   */
  async listBookingsForDate(dateISO: string): Promise<BookingConfirmation[]> {
    await simulateLatency(150);
    return this.bookings
      .filter((b) => b.date === dateISO)
      .sort((a, b) => a.time.localeCompare(b.time));
  }
}
