// The PUBLIC-safe contract. Anything reachable from the public booking flow
// goes through this interface — it is deliberately narrow: a visitor can
// read services, read availability, and create a booking. Nothing here lets
// a caller read other customers' data (see adminBookingService.ts for the
// separate, privileged contract that requires the owner to be authenticated).
//
// Swap implementations by changing ONLY getBookingService() below — every
// component calls that factory, never a concrete class, so the UI needs zero
// changes when a real backend replaces the demo one.

import type { BookingConfirmation, BookingRequest, Service, TimeSlot } from "./types";
import { DemoBookingService } from "./demoBookingService";

export interface BookingService {
  getServices(): Promise<Service[]>;
  /** ISO dates (within the booking window) that have at least one free slot for this service. */
  getAvailableDates(serviceId: string): Promise<string[]>;
  getAvailableSlots(dateISO: string, serviceId: string): Promise<TimeSlot[]>;
  createBooking(request: BookingRequest): Promise<BookingConfirmation>;
}

let instance: DemoBookingService | null = null;

function getInstance(): DemoBookingService {
  instance ??= new DemoBookingService();
  return instance;
}

/**
 * Single swap point. Later:
 *   import { SupabaseBookingService } from "./supabaseBookingService";
 *   return new SupabaseBookingService();
 * The return type here is the narrow public interface — callers only ever
 * see getServices/getAvailableDates/getAvailableSlots/createBooking, even
 * though the demo instance also has admin-only methods (see
 * adminBookingService.ts, which is the only other file allowed to reach
 * into this same instance).
 */
export function getBookingService(): BookingService {
  return getInstance();
}

/** @internal — for adminBookingService.ts only. Not part of the public contract. */
export function getSharedDemoInstance(): DemoBookingService {
  return getInstance();
}
