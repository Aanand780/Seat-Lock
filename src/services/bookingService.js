// src/services/bookingService.js

const { pool } = require('../db/pool');
const { withTransaction } = require('../db/tx');
const { v7: uuidv7 } = require('uuid');
const { writeAudit, ForbiddenError } = require('./auditService');
const { ConflictError } = require('./eventService');

/**
 * Retrieves the seat map with computed availability states.
 * States: 'available', 'held', 'booked', 'blocked'.
 */
async function getSeatMap(currentUser, eventId) {
  // Fetch event
  const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  const event = eventRes.rows[0];
  if (!event) {
    throw new Error('Event not found.');
  }

  // If event is draft, verify access
  if (event.status !== 'published') {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.id !== event.organizer_id)) {
      throw new ForbiddenError('You do not have access to view this unpublished seat map.');
    }
  }

  // Fetch all seats ordered by row and col
  const seatsRes = await pool.query(
    'SELECT * FROM seats WHERE event_id = $1 ORDER BY row_name ASC, seat_col ASC',
    [eventId]
  );
  const seats = seatsRes.rows;

  // Fetch active holds (expires_at > now())
  const holdsRes = await pool.query(
    'SELECT seat_id, user_id, expires_at FROM holds WHERE event_id = $1 AND expires_at > now()',
    [eventId]
  );
  const holdsMap = new Map();
  holdsRes.rows.forEach(h => holdsMap.set(h.seat_id, h));

  // Fetch active bookings
  const bookingsRes = await pool.query(
    `SELECT bs.seat_id, b.user_id 
     FROM booking_seats bs 
     JOIN bookings b ON bs.booking_id = b.id 
     WHERE b.event_id = $1 AND bs.status = 'ACTIVE'`,
    [eventId]
  );
  const bookedSet = new Set(bookingsRes.rows.map(b => b.seat_id));

  const now = Date.now();
  let userActiveHold = null;

  // Annotate each seat with status
  const mappedSeats = seats.map(s => {
    let status = 'available';
    let isHeldByMe = false;
    let holdExpiresIn = 0;

    if (s.is_blocked) {
      status = 'blocked';
    } else if (bookedSet.has(s.id)) {
      status = 'booked';
    } else if (holdsMap.has(s.id)) {
      status = 'held';
      const hold = holdsMap.get(s.id);
      if (currentUser && hold.user_id === currentUser.id) {
        isHeldByMe = true;
        holdExpiresIn = Math.max(0, Math.floor((new Date(hold.expires_at).getTime() - now) / 1000));
        if (!userActiveHold) {
          userActiveHold = {
            expiresAt: hold.expires_at,
            expiresInSeconds: holdExpiresIn,
            seats: [],
          };
        }
        userActiveHold.seats.push(s.seat_number);
      }
    }

    return {
      id: s.id,
      seatNumber: s.seat_number,
      row: s.row_name,
      col: s.seat_col,
      status,
      isHeldByMe,
      holdExpiresIn,
    };
  });

  return {
    event,
    seats: mappedSeats,
    userActiveHold,
  };
}

/**
 * Atomically holds 1-4 seats for 5 minutes with pessimistic row locking.
 * Enforces all-or-nothing semantics, quota limits, and stable lock ordering.
 */
async function holdSeats(currentUser, { eventId, seatIds }) {
  // 1. Role verification
  if (!currentUser || currentUser.role !== 'student') {
    throw new ForbiddenError('Only students may hold and book seats.');
  }

  // 2. Validate seat count
  if (!Array.isArray(seatIds) || seatIds.length < 1 || seatIds.length > 4) {
    throw new ConflictError('You must hold between 1 and 4 seats.');
  }

  // 3. Event and timing check
  const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  const event = eventRes.rows[0];
  if (!event) throw new Error('Event not found.');

  if (event.status !== 'published') {
    throw new ConflictError('Cannot hold seats for an unpublished event.');
  }

  if (new Date(event.start_time) <= new Date()) {
    throw new ConflictError('Booking has closed because the event has already started.');
  }

  // 4. Check student quota: Max 4 booked seats per event
  const bookedCountRes = await pool.query(
    `SELECT count(bs.id) as count 
     FROM booking_seats bs 
     JOIN bookings b ON bs.booking_id = b.id 
     WHERE b.event_id = $1 AND b.user_id = $2 AND bs.status = 'ACTIVE'`,
    [eventId, currentUser.id]
  );
  const alreadyBooked = parseInt(bookedCountRes.rows[0].count, 10) || 0;
  if (alreadyBooked + seatIds.length > 4) {
    throw new ConflictError(
      `Limit exceeded: You already have ${alreadyBooked} booked seats. A maximum of 4 seats per student is allowed.`
    );
  }

  // 5. Stable lock order to prevent deadlocks: sort ascending by ID
  const sortedSeatIds = [...new Set(seatIds)].sort();
  const seatPlaceholders = sortedSeatIds.map((_, i) => `$${i + 1}`).join(', ');
  const seatPlaceholdersFrom2 = sortedSeatIds.map((_, i) => `$${i + 2}`).join(', ');

  // Fetch seat numbers upfront for error mapping and safety net
  const seatLookup = await pool.query(
    `SELECT id, seat_number FROM seats WHERE id IN (${seatPlaceholders})`,
    sortedSeatIds
  );
  const seatNumberMap = new Map();
  seatLookup.rows.forEach(s => seatNumberMap.set(s.id, s.seat_number));

  try {
    return await withTransaction(async (client) => {
      // Row-level lock on seats
      const seatsRes = await client.query(
        `SELECT id, seat_number, is_blocked 
         FROM seats 
         WHERE event_id = $1 AND id IN (${seatPlaceholdersFrom2}) 
         ORDER BY id ASC 
         FOR UPDATE`,
        [eventId, ...sortedSeatIds]
      );

      if (seatsRes.rows.length !== sortedSeatIds.length) {
        throw new ConflictError('One or more selected seats do not exist for this event.');
      }

      const seatsMap = new Map();
      seatsRes.rows.forEach(s => seatsMap.set(s.id, s));

      const unavailableSeats = [];

      // Check blocked seats
      for (const seat of seatsRes.rows) {
        if (seat.is_blocked) {
          unavailableSeats.push(seat.seat_number);
        }
      }

      // Check active bookings
      const bookedRes = await client.query(
        `SELECT bs.seat_id, s.seat_number 
         FROM booking_seats bs 
         JOIN seats s ON bs.seat_id = s.id 
         WHERE bs.seat_id IN (${seatPlaceholders}) AND bs.status = 'ACTIVE'`,
        sortedSeatIds
      );
      for (const row of bookedRes.rows) {
        if (!unavailableSeats.includes(row.seat_number)) {
          unavailableSeats.push(row.seat_number);
        }
      }

      // Check unexpired holds by someone else (inside transaction)
      const holdsRes = await client.query(
        `SELECT h.seat_id, s.seat_number, h.user_id, h.expires_at 
         FROM holds h 
         JOIN seats s ON h.seat_id = s.id 
         WHERE h.seat_id IN (${seatPlaceholders})`,
        sortedSeatIds
      );

      const now = new Date();
      for (const row of holdsRes.rows) {
        // If held by another user and not expired
        if (row.user_id !== currentUser.id && new Date(row.expires_at) > now) {
          if (!unavailableSeats.includes(row.seat_number)) {
            unavailableSeats.push(row.seat_number);
          }
        }
      }

      // All-or-nothing check: If ANY seat is unavailable, reject entire hold
      if (unavailableSeats.length > 0) {
        const error = new ConflictError(
          `Seats unavailable: ${unavailableSeats.join(', ')}`,
          { unavailableSeats }
        );
        throw error;
      }

      // Free previous hold by this student for this event (one active hold per student per event)
      await client.query(
        'DELETE FROM holds WHERE event_id = $1 AND user_id = $2',
        [eventId, currentUser.id]
      );

      // Free any expired holds on these seats
      await client.query(
        `DELETE FROM holds WHERE seat_id IN (${seatPlaceholders}) AND expires_at <= now()`,
        sortedSeatIds
      );

      // Insert new 5-minute hold rows
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      for (const seatId of sortedSeatIds) {
        const holdId = uuidv7();
        await client.query(
          `INSERT INTO holds (id, event_id, user_id, seat_id, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [holdId, eventId, currentUser.id, seatId, expiresAt]
        );
      }

      // Write SEAT_HOLD audit row within the SAME transaction
      await writeAudit(
        {
          eventId,
          actorId: currentUser.id,
          action: 'SEAT_HOLD',
          details: {
            seatIds: sortedSeatIds,
            seatNumbers: sortedSeatIds.map(id => seatsMap.get(id).seat_number),
            expiresAt: expiresAt.toISOString(),
          }
        },
        client
      );

      return {
        success: true,
        eventId,
        seatIds: sortedSeatIds,
        seatNumbers: sortedSeatIds.map(id => seatsMap.get(id).seat_number),
        expiresAt,
      };
    });
  } catch (err) {
    // Ensure all-or-nothing cleanup: delete any partial hold inserted before error
    try {
      await pool.query('DELETE FROM holds WHERE event_id = $1 AND user_id = $2', [eventId, currentUser.id]);
    } catch (_) {}

    // Database unique constraint violation safety net
    if (
      err.code === '23505' ||
      (err.message && err.message.toLowerCase().includes('unique constraint')) ||
      (err.message && err.message.toLowerCase().includes('duplicate key'))
    ) {
      const unavailableSeatNames = sortedSeatIds.map(id => seatNumberMap.get(id) || id);
      err = new ConflictError(
        `Seats unavailable: ${unavailableSeatNames.join(', ')}`,
        { unavailableSeats: unavailableSeatNames }
      );
    }

    if (err instanceof ConflictError) {
      // Record rejection audit on separate pool connection
      await writeAudit({
        eventId,
        actorId: currentUser.id,
        action: 'SEAT_HOLD_REJECTED',
        details: {
          requestedSeats: sortedSeatIds,
          unavailableSeats: err.details?.unavailableSeats || [],
          reason: err.message,
        }
      });
    }
    throw err;
  }
}

/**
 * Confirms an unexpired hold into a permanent booking.
 * Idempotent: repeated confirmations return the existing booking.
 */
async function confirmHold(currentUser, { eventId }) {
  if (!currentUser || currentUser.role !== 'student') {
    throw new ForbiddenError('Only students may confirm bookings.');
  }

  return await withTransaction(async (client) => {
    // 1. Lock current student's holds for this event
    const holdsRes = await client.query(
      `SELECT h.*, s.seat_number 
       FROM holds h 
       JOIN seats s ON h.seat_id = s.id 
       WHERE h.event_id = $1 AND h.user_id = $2 
       FOR UPDATE`,
      [eventId, currentUser.id]
    );

    if (holdsRes.rows.length === 0) {
      // Idempotent check: Did this user confirm a booking for this event recently?
      const recentBooking = await client.query(
        `SELECT b.id, b.status, b.created_at,
                json_agg(s.seat_number) as seats
         FROM bookings b
         JOIN booking_seats bs ON bs.booking_id = b.id
         JOIN seats s ON bs.seat_id = s.id
         WHERE b.event_id = $1 AND b.user_id = $2 AND b.status = 'CONFIRMED'
           AND b.created_at > now() - INTERVAL '10 minutes'
         GROUP BY b.id
         ORDER BY b.created_at DESC
         LIMIT 1`,
        [eventId, currentUser.id]
      );

      if (recentBooking.rows.length > 0) {
        return {
          success: true,
          bookingId: recentBooking.rows[0].id,
          seatNumbers: recentBooking.rows[0].seats,
          isIdempotent: true,
        };
      }

      throw new ConflictError('No active hold found to confirm. It may have expired or already been processed.');
    }

    // 2. Check hold expiry inside transaction
    const now = new Date();
    const firstHold = holdsRes.rows[0];
    if (new Date(firstHold.expires_at) <= now) {
      // Hold has expired
      await client.query(
        'DELETE FROM holds WHERE event_id = $1 AND user_id = $2',
        [eventId, currentUser.id]
      );
      throw new ConflictError('Your seat hold has expired. Please hold the seats again.');
    }

    // 3. Check event start time
    const eventRes = await client.query('SELECT start_time FROM events WHERE id = $1', [eventId]);
    if (new Date(eventRes.rows[0].start_time) <= now) {
      throw new ConflictError('Booking has closed because the event has started.');
    }

    // 4. Create booking
    const bookingId = uuidv7();
    await client.query(
      `INSERT INTO bookings (id, event_id, user_id, status, is_checked_in, created_at, updated_at)
       VALUES ($1, $2, $3, 'CONFIRMED', false, now(), now())`,
      [bookingId, eventId, currentUser.id]
    );

    // 5. Insert booking_seats
    const seatNumbers = [];
    for (const hold of holdsRes.rows) {
      const bsId = uuidv7();
      await client.query(
        `INSERT INTO booking_seats (id, booking_id, seat_id, status, created_at)
         VALUES ($1, $2, $3, 'ACTIVE', now())`,
        [bsId, bookingId, hold.seat_id]
      );
      seatNumbers.push(hold.seat_number);
    }

    // 6. Delete the hold
    await client.query(
      'DELETE FROM holds WHERE event_id = $1 AND user_id = $2',
      [eventId, currentUser.id]
    );

    // 7. Write BOOKING_CONFIRMED audit row in the SAME transaction
    await writeAudit(
      {
        eventId,
        actorId: currentUser.id,
        action: 'BOOKING_CONFIRMED',
        details: {
          bookingId,
          seats: seatNumbers,
        }
      },
      client
    );

    return {
      success: true,
      bookingId,
      seatNumbers,
    };
  });
}

/**
 * Cancels a student's booking and frees active seats.
 */
async function cancelBooking(currentUser, bookingId) {
  if (!currentUser) {
    throw new ForbiddenError('Authentication required.');
  }

  return await withTransaction(async (client) => {
    const bookingRes = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
      [bookingId]
    );

    const booking = bookingRes.rows[0];
    if (!booking) {
      throw new Error('Booking not found.');
    }

    if (booking.status !== 'CONFIRMED') {
      throw new ConflictError('Only confirmed bookings can be cancelled.');
    }

    // Ownership check: Student can only cancel their own; Admin can cancel any
    if (currentUser.role !== 'admin' && booking.user_id !== currentUser.id) {
      throw new ForbiddenError('You can only cancel your own bookings.');
    }

    // Check event start time
    const eventRes = await client.query('SELECT start_time FROM events WHERE id = $1', [booking.event_id]);
    if (new Date(eventRes.rows[0].start_time) <= new Date()) {
      throw new ConflictError('Cannot cancel bookings for events that have already started.');
    }

    // Update booking to CANCELLED
    await client.query(
      `UPDATE bookings SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
      [bookingId]
    );

    // Update booking_seats to CANCELLED (frees the unique constraint)
    await client.query(
      `UPDATE booking_seats SET status = 'CANCELLED' WHERE booking_id = $1`,
      [bookingId]
    );

    // Write BOOKING_CANCELLED audit row in same transaction
    await writeAudit(
      {
        eventId: booking.event_id,
        actorId: currentUser.id,
        action: 'BOOKING_CANCELLED',
        details: { bookingId }
      },
      client
    );

    return { success: true, bookingId };
  });
}

/**
 * Lists all bookings for the logged-in student.
 */
async function listMyBookings(currentUser) {
  if (!currentUser) {
    throw new ForbiddenError('Authentication required.');
  }

  const res = await pool.query(
    `SELECT b.id, b.status, b.is_checked_in, b.checked_in_at, b.created_at,
            e.id as event_id, e.title as event_title, e.venue as event_venue, e.start_time as event_start_time,
            COALESCE(
              json_agg(json_build_object('seat_id', s.id, 'seat_number', s.seat_number))
              FILTER (WHERE s.id IS NOT NULL), '[]'
            ) as seats
     FROM bookings b
     JOIN events e ON b.event_id = e.id
     LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     LEFT JOIN seats s ON bs.seat_id = s.id
     WHERE b.user_id = $1
     GROUP BY b.id, e.id
     ORDER BY b.created_at DESC`,
    [currentUser.id]
  );

  return res.rows;
}

module.exports = {
  getSeatMap,
  holdSeats,
  confirmHold,
  cancelBooking,
  listMyBookings,
};
