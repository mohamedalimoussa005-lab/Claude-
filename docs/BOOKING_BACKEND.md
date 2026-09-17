# Booking backend — proposed design (not deployed)

Status: **design only**. Nothing in this document is deployed. The live site
runs entirely on `DemoBookingService` (in-memory, resets on reload — see
`src/booking/`). This doc is what gets built when the client approves and we
connect a real backend (Supabase, per the current plan).

The frontend already calls a `BookingService` interface
(`src/booking/bookingService.ts`), not a concrete implementation, so
switching to the schema below should require **zero changes to any
component** — only a new `SupabaseBookingService` class and one line in
`getBookingService()`.

---

## 1. Schema

```sql
create table services (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  duration_minutes int  not null check (duration_minutes > 0),
  price_cents      int  not null check (price_cents >= 0),
  active           boolean not null default true,
  sort_order       int not null default 0
);

create table staff (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  active   boolean not null default true,
  -- links this row to a Supabase auth user for the admin dashboard;
  -- null until the owner/staff member has a login.
  user_id  uuid references auth.users (id)
);

create table staff_services (
  staff_id    uuid not null references staff (id) on delete cascade,
  service_id  uuid not null references services (id) on delete cascade,
  primary key (staff_id, service_id)
);

create table business_hours (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references staff (id) on delete cascade, -- null = whole-shop default
  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0=Sunday
  open_time   time not null,
  close_time  time not null,
  check (close_time > open_time)
);

create table blocked_times (
  id        uuid primary key default gen_random_uuid(),
  staff_id  uuid not null references staff (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  reason    text, -- internal only, never exposed publicly (see §3)
  check (ends_at > starts_at)
);

create type booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');

create table bookings (
  id                  uuid primary key default gen_random_uuid(),
  service_id          uuid not null references services (id),
  staff_id            uuid not null references staff (id),
  customer_first_name text not null,
  customer_last_name  text not null,
  customer_phone      text not null,
  customer_email      text,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null, -- computed server-side, see §2
  status              booking_status not null default 'confirmed',
  created_at          timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index bookings_staff_time_idx on bookings (staff_id, starts_at);
create index blocked_times_staff_time_idx on blocked_times (staff_id, starts_at);
create index business_hours_day_idx on business_hours (day_of_week);
```

## 2. Preventing double bookings

Two layers, because app-level "check then insert" always has a race window
under concurrent requests:

**Database constraint (the real guarantee).** Use the `btree_gist`
extension and an exclusion constraint so Postgres itself rejects any
overlapping range for the same staff member, atomically, even under
concurrent writes:

```sql
create extension if not exists btree_gist;

alter table bookings
  add constraint bookings_no_overlap
  exclude using gist (
    staff_id with =,
    tsrange(starts_at, ends_at, '[)') with &&
  )
  where (status in ('pending', 'confirmed'));
```

A cancelled booking's range is excluded from the constraint (`where`
clause), so cancelling frees the slot for re-booking.

**Server-side function (the entry point).** The public client never
`insert`s into `bookings` directly. It calls a single RPC:

```sql
create function create_booking(
  p_service_id uuid,
  p_staff_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text
) returns bookings
language plpgsql
security definer
as $$
declare
  v_duration int;
  v_ends_at timestamptz;
  v_booking bookings;
begin
  select duration_minutes into v_duration from services where id = p_service_id and active;
  if v_duration is null then
    raise exception 'Unknown or inactive service';
  end if;

  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  -- business-hours / blocked-time checks happen here too (omitted for
  -- brevity) — reject before insert so the client gets a clear error
  -- rather than relying solely on the exclusion constraint.

  insert into bookings (service_id, staff_id, starts_at, ends_at,
                         customer_first_name, customer_last_name, customer_phone, customer_email)
  values (p_service_id, p_staff_id, p_starts_at, v_ends_at,
          p_first_name, p_last_name, p_phone, p_email)
  returning * into v_booking;

  return v_booking;
end;
$$;
```

`ends_at` is always computed server-side from the service's real duration —
the client sends a start time and a service id, never an end time. This
closes off a class of bug/abuse where a manipulated client could submit a
booking with the wrong duration.

If two requests race for the same slot, one `insert` succeeds and the other
hits `bookings_no_overlap` and raises a Postgres exception — surfaced to the
client as "Ce créneau vient d'être réservé, choisissez-en un autre." (the
exact message `DemoBookingService.createBooking` already shows today for
its in-memory equivalent of this race).

## 3. Security — what the public site may and may not do

This is the part `DemoBookingService`/`AdminBookingService` already model in
code (`src/booking/bookingService.ts` vs `src/booking/adminBookingService.ts`)
so the real backend just has to fill in the same split:

| Data | Public (anon) | Owner (authenticated) |
| --- | --- | --- |
| `services` (active only) | read | read/write |
| `business_hours` | read | read/write |
| `staff` (name, active only) | read | read/write |
| `blocked_times` | **no direct read** (folded into availability RPC) | read/write |
| `bookings` | **no read at all** — write only via `create_booking` RPC | read/write |

Row Level Security, enabled on every table:

```sql
alter table bookings enable row level security;
alter table blocked_times enable row level security;
alter table services enable row level security;
alter table business_hours enable row level security;
alter table staff enable row level security;

-- Public: read-only, active rows only, on the safe tables.
create policy public_read_services on services for select using (active);
create policy public_read_hours on business_hours for select using (true);
create policy public_read_staff on staff for select using (active);

-- Bookings: NO public select policy at all — the absence of a policy
-- means RLS denies every row to the anon role by default. Public access
-- to write happens exclusively through create_booking(), which runs as
-- `security definer` and therefore bypasses RLS deliberately, inside a
-- function whose logic we control (unlike a raw INSERT policy, which
-- can't easily express "and recompute ends_at server-side").

-- Owner/staff: full access, scoped to an authenticated session.
create policy staff_manage_bookings on bookings for all
  using (auth.uid() in (select user_id from staff where user_id is not null))
  with check (auth.uid() in (select user_id from staff where user_id is not null));
```

For **availability** (which slots are free), expose a second RPC —
`get_available_slots(service_id, date)` — that runs the same open-hours /
breaks / existing-bookings / blocked-times logic as
`DemoBookingService.getAvailableSlots` does today (see
`src/booking/availability.ts`, which is already written backend-agnostic
for exactly this reason) and returns only start/end times. It never returns
`blocked_times.reason` or any other booking's customer data — just "free"
or "not free".

**Credentials.** Only the Supabase anon/public key ever ships in frontend
code (same as today, where nothing ships at all). The service-role key must
never appear in any file under `src/`, any `.env` committed to the repo, or
any client bundle — it stays server-side only (Supabase Edge Functions /
dashboard secrets), and is not needed anyway once `create_booking` and
`get_available_slots` are `security definer` functions callable by the anon
role directly.

## 4. Mapping onto the existing frontend interfaces

- `BookingService.getServices()` → `select * from services where active`
- `BookingService.getAvailableDates(serviceId)` → loop `get_available_slots`
  per day in range, or a dedicated `get_available_dates` RPC for efficiency
- `BookingService.getAvailableSlots(date, serviceId)` → `get_available_slots(service_id, date)`
- `BookingService.createBooking(request)` → `create_booking(...)`
- `AdminBookingService.listBookingsForDate(date)` → authenticated `select`
  on `bookings`, gated by the `staff_manage_bookings` RLS policy above —
  this query must only ever run from an authenticated admin session
  (`src/pages/Admin.tsx` today has no auth at all, by design, since it's
  demo-only; adding real auth to that page is part of activation, see
  `docs/CLIENT_ACTIVATION_CHECKLIST.md`).
