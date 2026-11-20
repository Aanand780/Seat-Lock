-- Migration 001: Add partial unique index safety net against double bookings
-- Ensures database-level impossibility of duplicate active bookings for the same seat

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_booking_seat 
ON booking_seats (seat_id) 
WHERE status = 'CONFIRMED';
