-- Migration 002: Add idempotency key support and waitlist table

-- 1. Add idempotency_key column to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100) UNIQUE;

-- 2. Create waitlist table
CREATE TABLE IF NOT EXISTS waitlist (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_seats_count INT DEFAULT 1 CHECK (requested_seats_count BETWEEN 1 AND 4),
    status VARCHAR(20) DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'NOTIFIED', 'EXPIRED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_event_student_waitlist UNIQUE (event_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_event_status ON waitlist (event_id, status, created_at ASC);
