-- ============================================================================
-- SEATLOCK DATABASE SCHEMA
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'ORGANIZER', 'STUDENT')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Events Table
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    venue VARCHAR(200) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    is_published BOOLEAN DEFAULT FALSE,
    organizer_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    version INT DEFAULT 1 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Seats Table
CREATE TABLE IF NOT EXISTS seats (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    row_label VARCHAR(10) NOT NULL,
    seat_number INT NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'BLOCKED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_event_seat UNIQUE (event_id, row_label, seat_number)
);

-- 4. Holds Table (2-step booking flow, 5 min expiry)
CREATE TABLE IF NOT EXISTS holds (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONFIRMED', 'EXPIRED', 'RELEASED')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Hold Seats Mapping
CREATE TABLE IF NOT EXISTS hold_seats (
    id SERIAL PRIMARY KEY,
    hold_id INT NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
    seat_id INT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    CONSTRAINT uq_hold_seat UNIQUE (hold_id, seat_id)
);

-- 6. Bookings Table
CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hold_id INT REFERENCES holds(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    checked_in BOOLEAN DEFAULT FALSE,
    checked_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Booking Seats Mapping
CREATE TABLE IF NOT EXISTS booking_seats (
    id SERIAL PRIMARY KEY,
    booking_id INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    seat_id INT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    CONSTRAINT uq_booking_seat_rel UNIQUE (booking_id, seat_id)
);

-- Partial Unique Index safety net: prevents any seat from having multiple active confirmed bookings
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_booking_seat ON booking_seats (seat_id) WHERE status = 'CONFIRMED';

-- 8. Sharded Audit Logs (audit_logs_0 through audit_logs_3)
DO $$
DECLARE
    i INT;
    tbl_name TEXT;
BEGIN
    FOR i IN 0..3 LOOP
        tbl_name := 'audit_logs_' || i;
        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I (
                id UUID PRIMARY KEY,
                actor_id INT REFERENCES users(id) ON DELETE SET NULL,
                actor_role VARCHAR(20),
                action VARCHAR(50) NOT NULL,
                event_id INT REFERENCES events(id) ON DELETE SET NULL,
                details JSONB DEFAULT ''{}''::jsonb,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS %I ON %I (created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS %I ON %I (event_id, created_at DESC);
        ', tbl_name, 'idx_' || tbl_name || '_cursor', tbl_name, 'idx_' || tbl_name || '_event', tbl_name);
    END LOOP;
END $$;

-- 9. Session Store for express-session (connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
