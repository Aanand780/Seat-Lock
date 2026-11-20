# SeatLock &mdash; High-Concurrency Event Seat Booking Platform

A secure, server-rendered (SSR) event seat-booking platform built for college fests. SeatLock guarantees zero double bookings under heavy concurrent spikes, enforces dual-layer server-side role-based access control (Admin, Organizer, Student), features a two-step booking lifecycle (5-minute hold to confirmation), and writes auditable activity across four sharded audit tables.

---

## Concurrency & Locking Strategy

> 1. To completely eliminate double bookings under high concurrency, SeatLock encapsulates every hold, confirmation, and cancellation inside a single ACID PostgreSQL transaction.
> 2. Contested seats are locked row-by-row using `SELECT ... FOR UPDATE` ordered strictly by primary key (`ORDER BY id ASC`), preventing circular deadlocks when concurrent users request overlapping seat selections.
> 3. Every transaction enforces a 2-second timeout via `SET LOCAL lock_timeout = '2s'`, immediately releasing waiting connections and returning HTTP 503 instead of hanging the application server under load.
> 4. Active hold expirations (5-minute TTL) and multi-seat availability are re-evaluated inside the locked critical section, guaranteeing atomic all-or-nothing hold placement before any state mutation.
> 5. As an impenetrable schema-level safety net, a PostgreSQL partial unique index on `booking_seats (seat_id) WHERE status = 'CONFIRMED'` guarantees that double booking remains physically impossible even in the event of an application software fault.

---

## Tech Stack & Architecture

- **Runtime**: Node.js 20 LTS
- **Web Framework**: Express 4 (SSR with EJS templates, strictly no SPA / React frontend)
- **Database**: PostgreSQL 16/17/19 with raw SQL via the native `pg` client
- **Session Store**: `express-session` with `connect-pg-simple` PostgreSQL backend
- **Security**: Bcrypt password hashing, SameSite + HttpOnly cookies, Cryptographic CSRF tokens
- **Layered Rules**: `routes -> middleware -> services -> db`. Routes never execute SQL. Service methods accept `currentUser` first and independently validate permissions.

---

## Core Entities & Data Model

- `users`: ID, name, email, password_hash, role (`ADMIN`, `ORGANIZER`, `STUDENT`)
- `events`: ID, title, description, venue, start_time, is_published, organizer_id, version (Optimistic Locking)
- `seats`: ID, event_id, row_label, seat_number, status (`AVAILABLE`, `BLOCKED`)
- `holds`: ID, event_id, student_id, expires_at, status (`ACTIVE`, `CONFIRMED`, `EXPIRED`, `RELEASED`)
- `hold_seats`: hold_id, seat_id mapping
- `bookings`: ID, event_id, student_id, hold_id, status (`CONFIRMED`, `CANCELLED`), checked_in, checked_in_at
- `booking_seats`: booking_id, seat_id, status (`CONFIRMED`, `CANCELLED`)
  - **Partial Unique Index**: `CREATE UNIQUE INDEX uq_active_booking_seat ON booking_seats(seat_id) WHERE status = 'CONFIRMED';`
- `audit_logs_0..3`: Sharded by `stable_hash(event_id) mod 4` (or `actor_id` for login/non-event actions)

---

## Quickstart & Setup

### Option 1: Docker Compose (One-command run)
```bash
docker compose up --build
```
The application will start on `http://localhost:3000` with PostgreSQL containerized and initialized.

### Option 2: Local Node.js + PostgreSQL
```bash
# 1. Install dependencies
npm install

# 2. Configure environment (.env)
PORT=3000
PGHOST=localhost
PGPORT=5432
PGDATABASE=seatlock
PGUSER=postgres
PGPASSWORD=yourpassword
SESSION_SECRET=seatlock-super-secure-production-secret-key-32chars

# 3. Initialize schema & seed test accounts
npm run db:init

# 4. Start application
npm start
```

---

## Seed Accounts (Quick Login)

| Role | Email | Password |
|---|---|---|
| **Admin** | `admin@collegefest.edu` | `Password123!` |
| **Organizer** | `organizer@collegefest.edu` | `Password123!` |
| **Organizer 2** | `sports@collegefest.edu` | `Password123!` |
| **Student** | `student@collegefest.edu` | `Password123!` |
| **Student 2** | `priya@collegefest.edu` | `Password123!` |

---

## Running Automated Tests

```bash
# Run all tests (deterministic sharding, RBAC, 20-way concurrency test)
npm test

# Run Phase 1 RBAC and Security tests only
npm run test:phase1

# Run Phase 2 Concurrency and Pessimistic Row Locking acceptance tests only
npm run test:phase2
```

---

## 8-Minute Hackathon Demo Script

1. **Student Booking Flow**:
   - Log in as `student@collegefest.edu`.
   - Browse published fest events, navigate to Seat Map.
   - Select 2 seats and click **Hold Selected Seats (5 min)**.
   - Navigate to **My Bookings**, observe active hold countdown.
   - Click **Confirm Booking**; seat status immediately becomes `BOOKED`.
2. **Security & RBAC (HTTP 403 Proof)**:
   - While logged in as `student@collegefest.edu`, attempt to open `/admin/audit-logs`.
   - Express route middleware & service layer trigger `deny()`.
   - The user receives an SSR `403 - Access Denied` error page.
   - Database writes an `ACCESS_DENIED` audit record into the routed shard.
3. **20-Way Concurrency Verification**:
   - Execute `npm run test:phase2`.
   - Observe 20 simultaneous parallel requests for the exact same seat producing **exactly 1 winner and 19 conflicts (409)**.
4. **Sharded Audit Log Viewer**:
   - Log in as `admin@collegefest.edu`, navigate to **Audit Logs (Sharded)**.
   - Select an event: UI indicates **Shard Pruning** (queries 1 shard).
   - Clear filter: UI indicates **Scatter-Gather** (queries all 4 shards and merges results with cursor pagination).
