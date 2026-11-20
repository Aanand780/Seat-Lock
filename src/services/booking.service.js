const db = require('../config/db');
const { writeAudit } = require('./audit.service');

/**
 * Get seat map for an event with dynamic status resolution:
 * A seat can be:
 * - AVAILABLE: unheld, unbooked, unblocked
 * - BLOCKED: blocked by organizer
 * - BOOKED: confirmed booking exists
 * - HELD: active unexpired hold exists
 *
 * @param {object|null} currentUser
 * @param {number} eventId
 */
async function getSeatMap(currentUser, eventId) {
  // Query all seats for event
  const seatsResult = await db.query(
    `SELECT s.id, s.row_label, s.seat_number, s.status, s.event_id
     FROM seats s
     WHERE s.event_id = $1
     ORDER BY s.row_label ASC, s.seat_number ASC`,
    [eventId]
  );

  const seats = seatsResult.rows;

  // Active confirmed bookings
  const bookedResult = await db.query(
    `SELECT bs.seat_id, b.student_id
     FROM booking_seats bs
     JOIN bookings b ON bs.booking_id = b.id
     WHERE b.event_id = $1 AND b.status = 'CONFIRMED' AND bs.status = 'CONFIRMED'`,
    [eventId]
  );
  const bookedSeatMap = new Map();
  bookedResult.rows.forEach(r => bookedSeatMap.set(r.seat_id, r.student_id));

  // Active unexpired holds
  const holdsResult = await db.query(
    `SELECT hs.seat_id, h.student_id, h.expires_at, h.id as hold_id
     FROM hold_seats hs
     JOIN holds h ON hs.hold_id = h.id
     WHERE h.event_id = $1 AND h.status = 'ACTIVE' AND h.expires_at > NOW()`,
    [eventId]
  );
  const heldSeatMap = new Map();
  holdsResult.rows.forEach(r => heldSeatMap.set(r.seat_id, r));

  const resolvedSeats = seats.map(seat => {
    let state = 'AVAILABLE';
    let heldByMe = false;
    let bookedByMe = false;

    if (seat.status === 'BLOCKED') {
      state = 'BLOCKED';
    } else if (bookedSeatMap.has(seat.id)) {
      state = 'BOOKED';
      if (currentUser && currentUser.id === bookedSeatMap.get(seat.id)) {
        bookedByMe = true;
      }
    } else if (heldSeatMap.has(seat.id)) {
      state = 'HELD';
      const holdInfo = heldSeatMap.get(seat.id);
      if (currentUser && currentUser.id === holdInfo.student_id) {
        heldByMe = true;
      }
    }

    return {
      id: seat.id,
      row_label: seat.row_label,
      seat_number: seat.seat_number,
      state,
      heldByMe,
      bookedByMe,
    };
  });

  return resolvedSeats;
}

/**
 * List bookings and active holds for current student
 *
 * @param {object} currentUser - Must be STUDENT (or ADMIN)
 */
async function listMyBookings(currentUser) {
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required');
    error.statusCode = 401;
    throw error;
  }

  // Active holds
  const holdsResult = await db.query(
    `SELECT h.*, e.title as event_title, e.venue, e.start_time,
            COALESCE(json_agg(json_build_object('id', s.id, 'row', s.row_label, 'number', s.seat_number)) FILTER (WHERE s.id IS NOT NULL), '[]') as seats
     FROM holds h
     JOIN events e ON h.event_id = e.id
     LEFT JOIN hold_seats hs ON hs.hold_id = h.id
     LEFT JOIN seats s ON hs.seat_id = s.id
     WHERE h.student_id = $1 AND h.status = 'ACTIVE' AND h.expires_at > NOW()
     GROUP BY h.id, e.title, e.venue, e.start_time
     ORDER BY h.created_at DESC`,
    [currentUser.id]
  );

  // Confirmed & Cancelled bookings
  const bookingsResult = await db.query(
    `SELECT b.*, e.title as event_title, e.venue, e.start_time,
            COALESCE(json_agg(json_build_object('id', s.id, 'row', s.row_label, 'number', s.seat_number)) FILTER (WHERE s.id IS NOT NULL), '[]') as seats
     FROM bookings b
     JOIN events e ON b.event_id = e.id
     LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     LEFT JOIN seats s ON bs.seat_id = s.id
     WHERE b.student_id = $1
     GROUP BY b.id, e.title, e.venue, e.start_time
     ORDER BY b.created_at DESC`,
    [currentUser.id]
  );

  return {
    activeHolds: holdsResult.rows,
    bookings: bookingsResult.rows,
  };
}

/**
 * Hold seats (Phase 2 core)
 */
async function holdSeats(currentUser, eventId, seatIds) {
  // Stub for Phase 1 - fully fleshed out in Phase 2
  return { success: true };
}

/**
 * Confirm hold (Phase 2 core)
 */
async function confirmHold(currentUser, holdId) {
  return { success: true };
}

/**
 * Cancel booking (Phase 2 core)
 */
async function cancelBooking(currentUser, bookingId) {
  return { success: true };
}

module.exports = {
  getSeatMap,
  listMyBookings,
  holdSeats,
  confirmHold,
  cancelBooking,
};
