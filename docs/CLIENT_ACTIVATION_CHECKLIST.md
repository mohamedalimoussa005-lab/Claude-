# Client activation checklist

Everything the site currently shows for services, prices, hours and
availability is **demo data** (`src/config/booking.demo.ts` and the
homepage's own copy). Nothing here is presented to visitors as real LS
Barber information beyond what's already verified (name, address, phone,
Google rating — see `src/config/site.ts`). This checklist is what's needed
from LS Barber to replace the demo layer with reality, and the exact
technical steps to do it.

## 1. What we need from LS Barber

**Business**
- [ ] Real services offered
- [ ] Real prices per service
- [ ] Real duration per service (in minutes)
- [ ] Opening hours per day of the week
- [ ] Any seasonal/holiday closures to plan for

**Staff**
- [ ] Number of barbers taking bookings
- [ ] Names, if they should be displayed/selectable
- [ ] Which services each barber performs (if it varies per barber)

**Booking rules**
- [ ] Minimum notice before a booking (e.g. "at least 2h ahead")
- [ ] Maximum advance booking window (e.g. "up to 3 weeks ahead")
- [ ] Cancellation policy (and whether customers can self-cancel/reschedule)
- [ ] Recurring breaks (lunch, prayer, etc.) and any planned time off

**Contact / confirmation**
- [ ] Should customers get an email confirmation, SMS, both, or neither (v1)?
- [ ] Who receives the owner-side notification for a new booking, and how
      (email, SMS, just the /admin dashboard)?

**Media**
- [ ] Real salon interior photo(s) — the only remaining placeholder on the
      site (`public/assets/salon-interior.jpg`, see `public/assets/README.md`)
- [ ] Optionally, real photos to eventually replace the generated campaign
      imagery (hero chair, craft close-up, tools, atmosphere)

**Legal**
- [ ] Business registration details if a privacy notice / CGV page is
      required for collecting customer phone/email

## 2. Technical activation sequence

Do these in order. Steps 1–6 turn the demo into a real system; 7–10 are
pre-launch verification.

1. **Create/connect a Supabase project.** Add its URL and anon key as
   environment variables (never the service-role key — see
   `docs/BOOKING_BACKEND.md` §3).
2. **Apply the schema** from `docs/BOOKING_BACKEND.md` §1 (tables, the
   `btree_gist` exclusion constraint, indexes) and the RPC functions
   (`create_booking`, `get_available_slots`) and RLS policies from §2–3.
3. **Replace `src/config/booking.demo.ts`** with LS Barber's real services,
   hours, breaks and booking rules — sourced from section 1 above. This is
   the only config file that should need editing for business data;
   everything else already reads from a config layer, not hardcoded values.
4. **Write `SupabaseBookingService`** implementing the existing
   `BookingService` interface (`src/booking/bookingService.ts`), and point
   `getBookingService()` at it instead of `DemoBookingService`. Do the same
   for `AdminBookingService` behind real auth. No component should need to
   change — see `docs/BOOKING_BACKEND.md` §4 for the exact mapping.
5. **Add authentication to `/admin`** (Supabase Auth, scoped to the
   `staff.user_id` row from the schema) — it currently has none, by design,
   since it only ever shows demo data.
6. **Remove the demo-mode messaging**: the "Démonstration" line in
   `ReservationHeader`, the `isDemo` flag/banner in `ConfirmationStep`, and
   the `AdminPage` header badge — all are intentionally isolated to those
   three spots for exactly this reason.
7. **Test booking creation** end to end against the real database (not just
   the demo in-memory store).
8. **Test double-booking protection**: fire two near-simultaneous booking
   requests for the same slot and confirm the second is rejected with a
   clear message, not a silent overwrite or a crash.
9. **Test mobile** (390px and a real phone) through the full flow, and test
   the confirmation/admin path on a slow connection.
10. **Test owner/admin access**: confirm an unauthenticated visitor gets
    nothing from `/admin` or from any attempt to query `bookings` directly
    (e.g. via the browser network tab / Supabase REST endpoint), and that
    the owner's login sees the real schedule.
11. **Deploy the production build** (`npm run build`) behind real hosting
    and a real domain, with the Supabase environment variables set for that
    environment.

Nothing above requires touching the homepage, the visual design, or the
step-by-step booking UI — only the data layer and the three call sites
listed in step 6.
