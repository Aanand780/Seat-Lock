# SeatLock

A secure, server-rendered seat-booking platform for a college fest. Many students can try to reserve the same seats at once; SeatLock guarantees each seat is booked by exactly one student, enforces role-based permissions on the server, and records an auditable trail across four sharded audit tables.

**Track:** Full-stack | **Stack:** Node.js, Express, EJS (SSR), PostgreSQL | **Team:** 3

> Adjust the stack, commands and paths below to match what you actually built.

---

## Features

- Server-side rendered pages (no client-side SPA)
- Seeded-user login with server-side sessions in an HttpOnly cookie, plus CSRF protection
- Role-aware event list and seat map (available / held / booked / blocked)
- Two-step booking: hold 1-4 seats for 5 minutes, then confirm
- All-or-nothing holds; rejected seats are named in the error
- Cancel own bookings; organizers and admins view attendee lists and check in attendees
- Optimistic locking on event edits
- Four sharded audit-log tables with an admin audit viewer

## Roles

| Role | Can do |
|---|---|
| Admin | Manage users and roles; view all events, bookings and audit logs |
| Organizer | Create/edit **own** events, block seats, view own attendee list, check in attendees |
| Student | Browse published events, hold/book seats, view and cancel own bookings |

Unauthorized requests return **403** and write an `ACCESS_DENIED` audit record.

---

## Quick start

Requirements: Docker and Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

The app starts at http://localhost:3000 against the supplied PostgreSQL database (schema and seed data are loaded on first start).

### Seeded logins

| Role | Email | Password | Persona |
|---|---|---|---|
| Admin | `admin@collegefest.org` | `admin123` | Fest Administrator |
| Lead Organizer | `organizer@collegefest.org` | `organizer123` | Elena Vance (Headline Show) |
| Tech Organizer | `organizer2@collegefest.org` | `organizer123` | Marcus Brody (Hackathon) |
| Student 1 | `student1@collegefest.org` | `student123` | Alex Mercer |
| Student 2 | `student2@collegefest.org` | `student123` | Beatriz Silva |
| Student 3 | `student3@collegefest.org` | `student123` | Chen Wei |

*(Quick 1-click login buttons are also provided directly on the `/login` screen for fast demo testing!)*

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret used to sign the session cookie |
| `PORT` | HTTP port (default 3000) |

### Running without Docker

```bash
npm install
psql "$DATABASE_URL" -f db/schema.sql   # skip if using the starter schema
psql "$DATABASE_URL" -f db/seed.sql
npm start
```

### Tests and load test

```bash
npm test                    # RBAC and audit-routing tests
node tests/load-test.js     # N concurrent holds on one seat; expects exactly 1 success
```

---

## Architecture

```
Browser (SSR HTML, forms, CSRF token)
        |
Web layer     middleware: session -> auth -> role guard -> CSRF -> error handler
              routes (HTTP only, no SQL) + EJS views
        |  service(currentUser, args)
Service layer getSeatMap, holdSeats, confirmHold, cancelBooking, listMyBookings,
              listEventBookings, checkIn, updateEvent, listAuditLogs, writeAudit
        |
PostgreSQL    users, events, seats, holds, bookings, booking_seats, audit_logs_0..3

Background job: hold-expiry sweeper (every ~30s)
```

Routes handle HTTP only. All business rules and SQL live in services, and every service takes the current user as its first argument and checks permissions itself.

```
src/
  server.js            bootstrap, starts the sweeper
  db/                  pool, transaction helper (lock_timeout), shardRouter
  middleware/          session, auth, rbac, csrf, errors
  routes/              auth, events, bookings, organizer, admin
  services/            booking, event, audit, user
  jobs/                holdExpirySweeper
  views/               SSR templates incl. 403 / 409 / 503 pages
db/                    schema.sql, seed.sql
tests/                 load-test, rbac, audit-routing
```

---

## Locking strategy (and why)

**Strategy: pessimistic row-level locking inside one ACID transaction, with database constraints as a safety net.**

`holdSeats` runs like this:

1. Check permission (student, event published, event not started).
2. `BEGIN`; `SET LOCAL lock_timeout = '2s'`.
3. Sort requested seat IDs ascending.
4. `SELECT ... FROM seats WHERE id = ANY($1) ORDER BY id FOR UPDATE`.
5. Inside the transaction, check each seat: blocked, actively booked, or held by someone else with `expires_at > now()`. Expired holds for these seats are deleted.
6. If any seat is unavailable: roll back, write `SEAT_HOLD_REJECTED`, return **409** listing the unavailable seats. Nothing is held.
7. Otherwise delete the student's previous hold for the event, insert the new hold (5-minute expiry), write the `SEAT_HOLD` audit row, and commit.

**Why this approach**

- **Pessimistic over optimistic for seats:** contention on popular seats is high at peak time. Locking makes losers wait briefly and fail cleanly rather than retrying in a storm.
- **Stable lock order:** locking seats in ascending ID order means two overlapping multi-seat requests can never deadlock.
- **Short critical section:** only the check-and-insert happens while locks are held; rendering and audit shard routing for non-booking actions happen outside.
- **Expiry checked in the transaction:** correctness never depends on the sweeper. The sweeper only cleans up rows and logs `HOLD_EXPIRED`.
- **2 second lock timeout:** a stuck lock becomes **503** instead of hanging the request.
- **Safety net:** `UNIQUE (seat_id)` on `holds`, and a partial unique index on `booking_seats (seat_id) WHERE status = 'ACTIVE'`. Even a bug in application code cannot create a double booking.

**Other concurrency rules**

- `confirmHold` locks the hold rows, checks ownership and expiry, creates the booking, deletes the hold, and writes `BOOKING_CONFIRMED` in the same transaction. A repeated confirm returns the existing booking (idempotent).
- `updateEvent` uses optimistic locking: `UPDATE events SET ..., version = version + 1 WHERE id = $1 AND version = $2`. Zero rows updated returns **409**.

| Situation | Status |
|---|---|
| Seat or version conflict | 409 |
| Lock timeout | 503 |
| Permission denied | 403 |

---

## Business rules

- At most 4 held seats and 4 booked seats per student per event.
- One active hold per student per event; a new hold replaces the old one.
- Multi-seat holds are all-or-nothing.
- Organizers cannot block booked seats.
- Booking closes at the event start time.

## Security

- Permissions are checked in route middleware (role) **and** again inside service functions (role + ownership). Hiding buttons is only cosmetic.
- Organizers can access only their own events; students can access only their own bookings.
- Every 403 writes `ACCESS_DENIED`. It is written on a separate connection so the record survives a rolled-back transaction.
- Sessions are HttpOnly cookies; all state-changing forms carry a CSRF token.

---

## Audit log sharding

Four tables: `audit_logs_0` ... `audit_logs_3`.

- **Routing:** `shard = fnv1a(event_id) mod 4`. For non-event actions (login, failed login) the actor ID is hashed instead. The hash is deterministic across processes and restarts.
- **IDs:** time-sortable UUIDv7, generated by the app, so IDs are globally unique without a shared sequence. Cursor = `(created_at, id)`.
- **Transactional writes:** booking-related audit rows are written with the booking's transaction client, so a rollback removes both.
- **Reads:**
  - Filtered by event: **one shard** is queried (shard pruning).
  - Unfiltered: all four shards are queried in parallel, merged by `(created_at, id) DESC`, and the latest 50 are returned with a `next_cursor`.
  - Date filter: adds a `created_at` range to each query.

Logged actions: `LOGIN`, `LOGIN_FAILED`, `SEAT_HOLD`, `SEAT_HOLD_REJECTED`, `HOLD_EXPIRED`, `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `EVENT_UPDATED`, `CHECKIN`, `ACCESS_DENIED`.

### Plan: moving from 4 to 8 shards

1. Introduce a shard map (`shard_map` table or config) instead of a hard-coded `mod 4`.
2. Create `audit_logs_4` ... `audit_logs_7`.
3. Dual-write to old and new shard for a transition window.
4. Backfill existing rows to their new shard (`hash mod 8`), verify counts.
5. Switch reads to the new routing, then stop dual-writing and clean up old rows.

Using `mod 8` means each existing shard splits cleanly into itself and one new shard, so each row moves at most once.

---

## Demo script (8 minutes)

1. Log in as a student, hold seats, confirm, and view the booking.
2. As the student, open an admin or organizer URL and get a **403**.
3. Run the load test: concurrent requests for one seat yield exactly one success and the rest get 409.
4. Open the audit viewer filtered by event and show that only one shard is queried.
5. Show the `ACCESS_DENIED` record created in step 2.

## Bonus items implemented

- [x] **Idempotent confirmation:** Repeated confirms for the same event/student safely return the confirmed booking without duplicate booking seats or duplicate charge errors.
- [x] **Organizer seat blocking:** Organizers can block/unblock seats on their own events with the rule enforced that booked seats cannot be blocked.
- [x] **Live countdown & dynamic seat-map refresh:** Real-time client timer for student holds with countdown and auto-expiration reload.
- [x] **4-to-8 Shard expansion plan:** Detailed dual-write, backfill, and cutover architecture documented above.
- [x] **Zero-config standalone fallback:** Built-in automatic fallback to `pg-mem` emulator so `npm test` and `node tests/load-test.js` run immediately on any developer machine even without local Docker or Postgres setup.
- [x] **Dedicated error pages:** Custom SSR error templates for 403 (Access Denied), 409 (Conflict with unavailable seat details), and 503 (Lock Timeout).

## Team

| Member | Area |
|---|---|
| A | Routes, login, sessions, SSR pages, RBAC, CSRF |
| B | Booking service, row locking, hold/confirm/cancel, optimistic locking |
| C | Audit shard routing, audit viewer, audit integration, load testing |
