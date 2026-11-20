# SeatLock &mdash; High-Concurrency Event Seat Booking Platform

A secure, server-rendered (SSR) event seat-booking platform built for college fests. SeatLock guarantees zero double bookings under heavy concurrent spikes, enforces dual-layer server-side role-based access control (Admin, Organizer, Student), features a two-step booking lifecycle (5-minute hold to confirmation), and writes auditable activity across four sharded audit tables.

---

## 1. Concurrency & Locking Strategy (Why it Works)

> 1. To completely eliminate double bookings under high concurrency, SeatLock encapsulates every hold, confirmation, and cancellation inside a single ACID PostgreSQL transaction.
> 2. Contested seats are locked row-by-row using `SELECT ... FOR UPDATE` ordered strictly by primary key (`ORDER BY id ASC`), preventing circular deadlocks when concurrent users request overlapping seat selections.
> 3. Every transaction enforces a 2-second timeout via `SET LOCAL lock_timeout = '2s'`, immediately releasing waiting connections and returning HTTP 503 instead of hanging the application server under load.
> 4. Active hold expirations (5-minute TTL) and multi-seat availability are re-evaluated inside the locked critical section, guaranteeing atomic all-or-nothing hold placement before any state mutation.
> 5. As an impenetrable schema-level safety net, a PostgreSQL partial unique index on `booking_seats (seat_id) WHERE status = 'CONFIRMED'` guarantees that double booking remains physically impossible even in the event of an application software fault.

---

## 2. Audit Sharding Architecture

SeatLock partitions all auditable activity records across four distinct PostgreSQL tables: `audit_logs_0`, `audit_logs_1`, `audit_logs_2`, and `audit_logs_3`.

### Shard Routing Algorithm
- **Deterministic 32-bit FNV-1a Hash**:
  ```javascript
  function stableHash(key) {
    let hash = 2166136261;
    const str = String(key);
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0);
  }
  function getAuditShard(eventId, actorId) {
    const key = (eventId !== null && eventId !== undefined) ? eventId : actorId;
    return stableHash(key) % 4;
  }
  ```
- **Event-Related Actions** (`SEAT_HOLD`, `BOOKING_CONFIRMED`, `CHECKIN`, etc.): Routed by `stable_hash(event_id) mod 4`.
- **Non-Event Actions** (`LOGIN`, `LOGIN_FAILED`, etc.): Routed by `stable_hash(actor_id) mod 4`.
- **Transactional Consistency**: Booking audit rows are written using the exact same transaction client (`client`) that locks and commits the booking.
- **Shard Pruning vs Scatter-Gather**:
  - **Filtered by Event**: Targets **one shard only** (`audit_logs_${shard}`), bypassing all other tables.
  - **Unfiltered**: Fires 4 concurrent queries across `audit_logs_0..3` via `Promise.all()`, merges rows in memory, and returns the top 50 with `(created_at, id)` cursor pagination.

### 4-to-8 Shard Migration Plan
1. **Mathematical Invariant**: Because $8 = 4 \times 2$, changing from `hash % 4` to `hash % 8` causes each existing shard $i \in \{0, 1, 2, 3\}$ to split cleanly into exactly two target shards: $i$ and $(i + 4)$.
2. **Phase A (DDL Creation)**:
   ```sql
   CREATE TABLE audit_logs_4 (LIKE audit_logs_0 INCLUDING ALL);
   CREATE TABLE audit_logs_5 (LIKE audit_logs_0 INCLUDING ALL);
   CREATE TABLE audit_logs_6 (LIKE audit_logs_0 INCLUDING ALL);
   CREATE TABLE audit_logs_7 (LIKE audit_logs_0 INCLUDING ALL);
   ```
3. **Phase B (Online Split & Backfill)**:
   Run transactional split for each shard $i \in \{0, 1, 2, 3\}$:
   ```sql
   WITH moved AS (
     DELETE FROM audit_logs_0 
     WHERE (stable_hash(COALESCE(event_id::text, actor_id::text)) % 8) = 4
     RETURNING *
   )
   INSERT INTO audit_logs_4 SELECT * FROM moved;
   ```
4. **Phase C (Zero-Downtime Cutover)**:
   Deploy application configuration setting `NUM_SHARDS = 8`. `getAuditShard` now returns `hash % 8`.
5. **Phase D (Validation)**:
   Run row-count parity assertions across shards 0..7.

---

## 3. Project Structure & Layered Architecture

```
d:\Seat Lock\
├── docker-compose.yml              # PostgreSQL container & application definition
├── Dockerfile                      # Node.js 20 production container
├── package.json
├── README.md
├── scripts/
│   ├── schema.sql                  # PostgreSQL schema, partial unique index, audit shards
│   ├── seed.sql                    # Seeded users (bcrypt), events, seats
│   ├── init-db.js                  # Database initializer and seeder script
│   ├── load-test.js                # High-concurrency automated stress test (50 workers)
│   └── migrations/
│       └── 001_partial_unique_index.sql
├── src/
│   ├── server.js                   # HTTP entrypoint with graceful shutdown
│   ├── app.js                      # Express configuration, sessions, CSRF, EJS view engine
│   ├── config/
│   │   ├── db.js                   # pg.Pool and withTransaction helper with 2s lock timeout
│   │   └── session.js              # express-session with connect-pg-simple store
│   ├── middleware/
│   │   ├── auth.middleware.js      # Session context and req.user / res.locals injection
│   │   ├── rbac.middleware.js      # requireLogin, requireRole, requireEventOwner
│   │   ├── csrf.middleware.js      # Cryptographic CSRF token validation on POST/PUT/DELETE
│   │   └── error.middleware.js     # 403, 404, 409, 503, 500 error pages & code mappings
│   ├── services/
│   │   ├── audit.service.js        # writeAudit (transactional), listAuditLogs (pruning & cursor)
│   │   ├── booking.service.js      # holdSeats (FOR UPDATE), confirmHold, cancelBooking, getSeatMap
│   │   ├── event.service.js        # updateEvent (optimistic locking), listEventBookings, checkIn
│   │   └── user.service.js         # authenticateUser, bcrypt compare, audit hooks
│   ├── utils/
│   │   ├── deny.js                 # Central deny() helper logging ACCESS_DENIED and HTTP 403
│   │   └── sharding.js             # Deterministic 32-bit FNV-1a hash algorithm
│   ├── routes/
│   │   ├── auth.routes.js          # /login, /logout (No direct SQL)
│   │   ├── event.routes.js         # /events, /events/:id/seats, /events/:id/edit (No direct SQL)
│   │   ├── booking.routes.js       # /my-bookings, /events/:id/hold, /confirm, /cancel (No direct SQL)
│   │   ├── organizer.routes.js     # /organizer/events/:id/attendees, /checkin (No direct SQL)
│   │   └── audit.routes.js         # /admin/audit-logs (No direct SQL)
│   └── views/
│       ├── layouts/                # header.ejs (role-aware navbar), footer.ejs
│       ├── auth/                   # login.ejs (prefill quick-login buttons)
│       ├── events/                 # index.ejs, seat-map.ejs, edit.ejs, attendees.ejs
│       ├── bookings/               # my-bookings.ejs (countdown timer & cancellation)
│       ├── audit/                  # index.ejs (shard queries diagnostic & cursor pagination)
│       └── errors/                 # 403.ejs, 404.ejs, 409.ejs, 503.ejs, 500.ejs
└── tests/
    ├── sharding.test.js            # Deterministic hash & shard boundary unit tests
    ├── phase1-rbac.test.js         # Dual-layer RBAC, sessions, and CSRF tests
    ├── phase2-concurrency.test.js  # 20-way single-seat concurrency race test
    ├── phase3-audit.test.js        # Single-shard pruning vs 4-shard scatter-gather
    └── phase4-checkin.test.js      # Organizer event ownership & attendee check-in tests
```

---

## 4. Setup & Running the Application

### Option 1: Docker Compose (One Command)
```bash
docker compose up --build
```
Access at `http://localhost:3000`.

### Option 2: Local Node.js (v20+) + PostgreSQL
```bash
# 1. Install dependencies
npm install

# 2. Configure .env
cp .env.example .env

# 3. Apply schema & seed test accounts
npm run db:init

# 4. Start the application
npm start
```

---

## 5. Seeded Credentials

| Role | Email | Password | Allowed Capabilities |
|---|---|---|---|
| **Admin** | `admin@collegefest.edu` | `Password123!` | View all events, check in any attendee, view sharded audit logs across all tables |
| **Organizer 1** | `organizer@collegefest.edu` | `Password123!` | Manage own events, block seats, check in own attendees |
| **Organizer 2** | `sports@collegefest.edu` | `Password123!` | Manage own sports events; restricted from Organizer 1's events |
| **Student 1** | `student@collegefest.edu` | `Password123!` | Browse published shows, hold 1–4 seats (5 min), confirm, cancel own bookings |
| **Student 2** | `priya@collegefest.edu` | `Password123!` | Browse, hold, confirm, cancel bookings |

---

## 6. Automated Test Suites & Load Testing

```bash
# Run entire test suite (37 tests across all phases)
npm test

# Run high-concurrency load test (50 simultaneous requests competing for one seat)
npm run load-test

# Run individual phase suites
npm run test:phase1  # RBAC, CSRF, Secure Sessions
npm run test:phase2  # 20-way Concurrency Race, Lock Timeout, Hold Replacement
npm run test:phase3  # Audit Sharding, Shard Pruning, 4-Shard Scatter-Gather
npm run test:phase4  # Organizer Ownership, Attendee Check-In
```
