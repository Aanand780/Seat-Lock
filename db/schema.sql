-- SeatLock Database Schema

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'organizer', 'student')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Events Table (with optimistic locking version)
CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    venue VARCHAR(255) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'cancelled')),
    organizer_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_organizer_idx ON events (organizer_id);
CREATE INDEX IF NOT EXISTS events_status_idx ON events (status);

-- 3. Seats Table
CREATE TABLE IF NOT EXISTS seats (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    seat_number VARCHAR(20) NOT NULL,
    row_name VARCHAR(10) NOT NULL,
    seat_col INT NOT NULL,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT seats_event_seat_uq UNIQUE (event_id, seat_number)
);

CREATE INDEX IF NOT EXISTS seats_event_idx ON seats (event_id);

-- 4. Holds Table (5-minute seat reservation)
CREATE TABLE IF NOT EXISTS holds (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seat_id VARCHAR(36) NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT holds_seat_unique UNIQUE (seat_id)
);

CREATE INDEX IF NOT EXISTS holds_user_event_idx ON holds (event_id, user_id);
CREATE INDEX IF NOT EXISTS holds_expiry_idx ON holds (expires_at);

-- 5. Bookings Table
CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    is_checked_in BOOLEAN NOT NULL DEFAULT false,
    checked_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id);
CREATE INDEX IF NOT EXISTS bookings_event_idx ON bookings (event_id);

-- 6. Booking Seats Table
CREATE TABLE IF NOT EXISTS booking_seats (
    id VARCHAR(36) PRIMARY KEY,
    booking_id VARCHAR(36) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    seat_id VARCHAR(36) NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index: A seat can have only one ACTIVE booking (cancelled rows don't count)
CREATE UNIQUE INDEX IF NOT EXISTS booking_seats_active_seat_uq
    ON booking_seats (seat_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS booking_seats_booking_idx ON booking_seats (booking_id);

-- 7. Audit Log Shards: audit_logs_0, audit_logs_1, audit_logs_2, audit_logs_3
CREATE TABLE IF NOT EXISTS audit_logs_0 (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36),
    actor_id VARCHAR(36) NOT NULL,
    action VARCHAR(50) NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_0_event_ts ON audit_logs_0 (event_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_0_ts ON audit_logs_0 (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS audit_logs_1 (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36),
    actor_id VARCHAR(36) NOT NULL,
    action VARCHAR(50) NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_1_event_ts ON audit_logs_1 (event_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_1_ts ON audit_logs_1 (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS audit_logs_2 (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36),
    actor_id VARCHAR(36) NOT NULL,
    action VARCHAR(50) NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_2_event_ts ON audit_logs_2 (event_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_2_ts ON audit_logs_2 (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS audit_logs_3 (
    id VARCHAR(36) PRIMARY KEY,
    event_id VARCHAR(36),
    actor_id VARCHAR(36) NOT NULL,
    action VARCHAR(50) NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_3_event_ts ON audit_logs_3 (event_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_3_ts ON audit_logs_3 (created_at DESC, id DESC);
