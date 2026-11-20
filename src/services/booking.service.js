const db = require('../config/db');
const { writeAudit } = require('./audit.service');
const { broadcastSeatUpdate } = require('../utils/seatEvents');
const { processWaitlist } = require('./waitlist.service');

/**
 * Lazy cleanup of expired holds on read.
 * Updates expired active holds to 'EXPIRED' and logs HOLD_EXPIRED audit records.
 * Uses SKIP LOCKED so concurrent cleanup processes never block each other.
 *
 * @param {object} [client=null] - Optional pg client
 */
async function cleanupExpiredHolds(client = null) {
  const executor = client || db;

  // Use SKIP LOCKED for non-blocking concurrent hold sweeping
  const expiredRes = await executor.query(`
    UPDATE holds
    SET status = 'EXPIRED'
    WHERE id IN (
      SELECT id FROM holds
      WHERE status = 'ACTIVE' AND expires_at <= NOW()
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event_id, student_id;
  `);

  if (expiredRes.rows.length > 0) {
    for (const row of expiredRes.rows) {
      try {
        await writeAudit(null, {
          actorId: row.student_id,
          actorRole: 'STUDENT',
          action: 'HOLD_EXPIRED',
          eventId: row.event_id,
          details: { holdId: row.id, reason: 'Hold duration exceeded 5 minutes' },
          client,
        });

        // Broadcast released seats via SSE
        const seatsRes = await executor.query(
          `SELECT seat_id FROM hold_seats WHERE hold_id = $1`,
          [row.id]
        );
        const freedSeatIds = seatsRes.rows.map(r => r.seat_id);
        if (freedSeatIds.length > 0) {
          broadcastSeatUpdate(row.event_id, {
            type: 'SEAT_UPDATE',
            seatIds: freedSeatIds,
            state: 'AVAILABLE',
          });
        }

        // Trigger waitlist notification for freed seats
        await processWaitlist(row.event_id, client);
      } catch (err) {
        console.error('Error logging HOLD_EXPIRED audit:', err);
      }
    }
  }

  return expiredRes.rows.length;
}

/**
 * Get seat map for an event with dynamic status resolution:
 * AVAILABLE, BLOCKED, BOOKED, HELD
 *
 * @param {object|null} currentUser
 * @param {number} eventId
 */
async function getSeatMap(currentUser, eventId) {
  // Lazy cleanup of any expired holds first
  await cleanupExpiredHolds();

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
 * Hold 1-4 seats atomically for 5 minutes.
 * Supports lockingMode: 'WAIT' (default), 'NOWAIT', 'SKIP LOCKED'
 *
 * @param {object} currentUser
 * @param {number} eventId
 * @param {Array<number>} seatIds
 * @param {object} [options={}] - { lockingMode: 'WAIT'|'NOWAIT'|'SKIP LOCKED' }
 */
async function holdSeats(currentUser, eventId, seatIds, options = {}) {
  // Permission check
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required');
    error.statusCode = 401;
    throw error;
  }

  if (currentUser.role !== 'STUDENT' && currentUser.role !== 'ADMIN') {
    const error = new Error('Access denied: Only students can hold seats');
    error.statusCode = 403;
    throw error;
  }

  // Validate seat count (1 - 4 seats)
  if (!Array.isArray(seatIds) || seatIds.length < 1 || seatIds.length > 4) {
    const error = new Error('A student may hold between 1 and 4 seats per request');
    error.statusCode = 400;
    throw error;
  }

  // Convert to numbers and sort ascending for deadlock prevention
  const sortedSeatIds = [...new Set(seatIds.map(id => parseInt(id, 10)))].sort((a, b) => a - b);
  const parsedEventId = parseInt(eventId, 10);
  const lockingMode = options.lockingMode || 'WAIT'; // 'WAIT' | 'NOWAIT' | 'SKIP LOCKED'

  return await db.withTransaction(async (client) => {
    // 1. Check Event Start Time and Status
    const eventRes = await client.query(
      `SELECT id, title, start_time, is_published FROM events WHERE id = $1 FOR SHARE`,
      [parsedEventId]
    );
    const event = eventRes.rows[0];
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    if (new Date(event.start_time) <= new Date()) {
      const err = new Error('Booking has closed because the event has already started');
      err.statusCode = 409;
      throw err;
    }

    // 2. Check 4-booked seat limit for this student
    const bookedCountRes = await client.query(
      `SELECT COUNT(bs.id) as cnt
       FROM booking_seats bs
       JOIN bookings b ON bs.booking_id = b.id
       WHERE b.student_id = $1 AND b.event_id = $2 AND b.status = 'CONFIRMED' AND bs.status = 'CONFIRMED'`,
      [currentUser.id, parsedEventId]
    );
    const currentBookedCount = parseInt(bookedCountRes.rows[0].cnt, 10);
    if (currentBookedCount + sortedSeatIds.length > 4) {
      const err = new Error(`Limit reached: A student may own at most 4 booked seats per event. You currently have ${currentBookedCount} booked seats.`);
      err.statusCode = 409;
      throw err;
    }

    // 3. In-transaction cleanup of any expired holds
    await cleanupExpiredHolds(client);

    // 4. Construct locking SQL clause based on requested lockingMode
    let lockClause = 'FOR UPDATE';
    if (lockingMode === 'NOWAIT') {
      lockClause = 'FOR UPDATE NOWAIT';
    } else if (lockingMode === 'SKIP LOCKED') {
      lockClause = 'FOR UPDATE SKIP LOCKED';
    }

    const lockedSeatsRes = await client.query(
      `SELECT id, status, row_label, seat_number
       FROM seats
       WHERE id = ANY($1) AND event_id = $2
       ORDER BY id ASC
       ${lockClause}`,
      [sortedSeatIds, parsedEventId]
    );

    // If SKIP LOCKED skipped seats, or invalid seat IDs requested
    if (lockedSeatsRes.rows.length !== sortedSeatIds.length) {
      if (lockingMode === 'SKIP LOCKED') {
        const conflictErr = new Error('One or more requested seats could not be locked immediately (SKIP LOCKED)');
        conflictErr.statusCode = 409;
        throw conflictErr;
      }
      const err = new Error('One or more requested seat IDs do not exist for this event');
      err.statusCode = 400;
      throw err;
    }

    // 5. Check Seat Availability (All-or-Nothing check)
    const unavailableSeats = [];

    // 5a. Check blocked seats
    for (const seat of lockedSeatsRes.rows) {
      if (seat.status === 'BLOCKED') {
        unavailableSeats.push(seat.id);
      }
    }

    // 5b. Check confirmed bookings on these seats
    const existingBookings = await client.query(
      `SELECT bs.seat_id
       FROM booking_seats bs
       JOIN bookings b ON bs.booking_id = b.id
       WHERE bs.seat_id = ANY($1) AND b.status = 'CONFIRMED' AND bs.status = 'CONFIRMED'
       FOR UPDATE`,
      [sortedSeatIds]
    );
    existingBookings.rows.forEach(r => unavailableSeats.push(r.seat_id));

    // 5c. Check active unexpired holds by other users
    const existingHolds = await client.query(
      `SELECT hs.seat_id
       FROM hold_seats hs
       JOIN holds h ON hs.hold_id = h.id
       WHERE hs.seat_id = ANY($1)
         AND h.status = 'ACTIVE'
         AND h.expires_at > NOW()
         AND NOT (h.student_id = $2 AND h.event_id = $3)
       FOR UPDATE OF h`,
      [sortedSeatIds, currentUser.id, parsedEventId]
    );
    existingHolds.rows.forEach(r => unavailableSeats.push(r.seat_id));

    const uniqueUnavailable = [...new Set(unavailableSeats)].sort((a, b) => a - b);

    // If any requested seat is unavailable, reject ALL requested seats
    if (uniqueUnavailable.length > 0) {
      await writeAudit(currentUser, {
        actorId: currentUser.id,
        actorRole: currentUser.role,
        action: 'SEAT_HOLD_REJECTED',
        eventId: parsedEventId,
        details: {
          requestedSeatIds: sortedSeatIds,
          unavailableSeatIds: uniqueUnavailable,
          lockingMode,
          reason: 'One or more seats unavailable under all-or-nothing hold rule',
        },
        client,
      });

      const conflictErr = new Error(`Cannot hold seats. The following seat(s) are already unavailable: [${uniqueUnavailable.join(', ')}]`);
      conflictErr.statusCode = 409;
      conflictErr.unavailableSeatIds = uniqueUnavailable;
      throw conflictErr;
    }

    // 6. Replace Student's Previous Active Hold for this Event
    const prevHoldRes = await client.query(
      `SELECT id FROM holds
       WHERE student_id = $1 AND event_id = $2 AND status = 'ACTIVE'
       FOR UPDATE`,
      [currentUser.id, parsedEventId]
    );

    if (prevHoldRes.rows.length > 0) {
      const prevHoldId = prevHoldRes.rows[0].id;
      await client.query(
        `UPDATE holds SET status = 'RELEASED' WHERE id = $1`,
        [prevHoldId]
      );
    }

    // 7. Create New Hold (5-minute expiration)
    const holdRes = await client.query(
      `INSERT INTO holds (event_id, student_id, expires_at, status)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes', 'ACTIVE')
       RETURNING *`,
      [parsedEventId, currentUser.id]
    );
    const hold = holdRes.rows[0];

    // 8. Associate Seats with Hold
    for (const seatId of sortedSeatIds) {
      await client.query(
        `INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)`,
        [hold.id, seatId]
      );
    }

    // 9. Write SEAT_HOLD audit record in the SAME transaction
    await writeAudit(currentUser, {
      actorId: currentUser.id,
      actorRole: currentUser.role,
      action: 'SEAT_HOLD',
      eventId: parsedEventId,
      details: {
        holdId: hold.id,
        seatIds: sortedSeatIds,
        expiresAt: hold.expires_at,
        seatCount: sortedSeatIds.length,
        lockingMode,
      },
      client,
    });

    // 10. Broadcast real-time SSE seat update
    broadcastSeatUpdate(parsedEventId, {
      type: 'SEAT_UPDATE',
      seatIds: sortedSeatIds,
      state: 'HELD',
      studentId: currentUser.id,
    });

    return {
      success: true,
      hold,
      seatIds: sortedSeatIds,
      expiresAt: hold.expires_at,
    };
  });
}

/**
 * Confirm an unexpired seat hold into a permanent booking.
 * Fully Idempotent:
 * 1. Honors explicit client idempotencyKey.
 * 2. Safely re-returns confirmed booking if hold was already confirmed.
 *
 * @param {object} currentUser
 * @param {number} holdId
 * @param {object} [options={}] - { idempotencyKey: string|null }
 */
async function confirmHold(currentUser, holdId, options = {}) {
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required');
    error.statusCode = 401;
    throw error;
  }

  const parsedHoldId = parseInt(holdId, 10);
  const idempotencyKey = options?.idempotencyKey || null;

  return await db.withTransaction(async (client) => {
    // 1. Idempotency Check A: If idempotencyKey provided, check if booking exists
    if (idempotencyKey) {
      const existingKeyRes = await client.query(
        `SELECT b.*,
                COALESCE(json_agg(json_build_object('seat_id', bs.seat_id)) FILTER (WHERE bs.seat_id IS NOT NULL), '[]') as seats
         FROM bookings b
         LEFT JOIN booking_seats bs ON bs.booking_id = b.id
         WHERE b.idempotency_key = $1
         GROUP BY b.id`,
        [idempotencyKey]
      );

      if (existingKeyRes.rows.length > 0) {
        return {
          success: true,
          booking: existingKeyRes.rows[0],
          seats: existingKeyRes.rows[0].seats,
          idempotent: true,
        };
      }
    }

    // 2. Row-lock hold
    const holdRes = await client.query(
      `SELECT * FROM holds WHERE id = $1 FOR UPDATE`,
      [parsedHoldId]
    );
    const hold = holdRes.rows[0];

    if (!hold) {
      const err = new Error('Hold not found');
      err.statusCode = 404;
      throw err;
    }

    // Permission check: Own hold only (or Admin)
    if (hold.student_id !== currentUser.id && currentUser.role !== 'ADMIN') {
      const err = new Error('Access denied: You can only confirm your own seat holds');
      err.statusCode = 403;
      throw err;
    }

    // 3. Idempotency Check B: If hold is already CONFIRMED, return existing booking
    if (hold.status === 'CONFIRMED') {
      const existingHoldBooking = await client.query(
        `SELECT b.*,
                COALESCE(json_agg(json_build_object('seat_id', bs.seat_id)) FILTER (WHERE bs.seat_id IS NOT NULL), '[]') as seats
         FROM bookings b
         LEFT JOIN booking_seats bs ON bs.booking_id = b.id
         WHERE b.hold_id = $1
         GROUP BY b.id`,
        [parsedHoldId]
      );

      if (existingHoldBooking.rows.length > 0) {
        return {
          success: true,
          booking: existingHoldBooking.rows[0],
          seats: existingHoldBooking.rows[0].seats,
          idempotent: true,
        };
      }
    }

    if (hold.status !== 'ACTIVE') {
      const err = new Error(`Hold cannot be confirmed because status is '${hold.status}'`);
      err.statusCode = 409;
      throw err;
    }

    // Check expiry inside transaction
    if (new Date(hold.expires_at) <= new Date()) {
      await client.query(`UPDATE holds SET status = 'EXPIRED' WHERE id = $1`, [parsedHoldId]);
      await writeAudit(currentUser, {
        actorId: currentUser.id,
        actorRole: currentUser.role,
        action: 'HOLD_EXPIRED',
        eventId: hold.event_id,
        details: { holdId: parsedHoldId, reason: 'Hold expired during confirmation attempt' },
        client,
      });

      const err = new Error('Seat hold has expired. The seats have been released back to general inventory.');
      err.statusCode = 409;
      throw err;
    }

    // 4. Lock held seats in stable order
    const seatsRes = await client.query(
      `SELECT hs.seat_id, s.row_label, s.seat_number
       FROM hold_seats hs
       JOIN seats s ON hs.seat_id = s.id
       WHERE hs.hold_id = $1
       ORDER BY hs.seat_id ASC
       FOR UPDATE`,
      [parsedHoldId]
    );
    const seatIds = seatsRes.rows.map(r => r.seat_id);

    // 5. Safety check: Verify no partial unique index conflict
    const activeBookingCheck = await client.query(
      `SELECT seat_id FROM booking_seats WHERE seat_id = ANY($1) AND status = 'CONFIRMED' FOR UPDATE`,
      [seatIds]
    );
    if (activeBookingCheck.rows.length > 0) {
      const conflictSeats = activeBookingCheck.rows.map(r => r.seat_id);
      const err = new Error(`Double booking conflict: Seats [${conflictSeats.join(', ')}] already have confirmed bookings`);
      err.statusCode = 409;
      throw err;
    }

    // 6. Create confirmed Booking record (with optional idempotency_key)
    const bookingRes = await client.query(
      `INSERT INTO bookings (event_id, student_id, hold_id, status, idempotency_key)
       VALUES ($1, $2, $3, 'CONFIRMED', $4)
       RETURNING *`,
      [hold.event_id, currentUser.id, parsedHoldId, idempotencyKey]
    );
    const booking = bookingRes.rows[0];

    // 7. Create booking_seats associations (Protected by partial unique index)
    for (const seatId of seatIds) {
      await client.query(
        `INSERT INTO booking_seats (booking_id, seat_id, status)
         VALUES ($1, $2, 'CONFIRMED')`,
        [booking.id, seatId]
      );
    }

    // 8. Mark hold as CONFIRMED
    await client.query(
      `UPDATE holds SET status = 'CONFIRMED' WHERE id = $1`,
      [parsedHoldId]
    );

    // 9. Write BOOKING_CONFIRMED audit record in SAME transaction
    await writeAudit(currentUser, {
      actorId: currentUser.id,
      actorRole: currentUser.role,
      action: 'BOOKING_CONFIRMED',
      eventId: hold.event_id,
      details: {
        bookingId: booking.id,
        holdId: parsedHoldId,
        seatIds,
        seatsCount: seatIds.length,
        idempotencyKey,
      },
      client,
    });

    // 10. Broadcast real-time SSE seat update
    broadcastSeatUpdate(hold.event_id, {
      type: 'SEAT_UPDATE',
      seatIds,
      state: 'BOOKED',
      studentId: currentUser.id,
    });

    return {
      success: true,
      booking,
      seats: seatsRes.rows,
      idempotent: false,
    };
  });
}

/**
 * Cancel a student's own booking and release seats back to inventory.
 *
 * @param {object} currentUser
 * @param {number} bookingId
 */
async function cancelBooking(currentUser, bookingId) {
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required');
    error.statusCode = 401;
    throw error;
  }

  const parsedBookingId = parseInt(bookingId, 10);

  return await db.withTransaction(async (client) => {
    // 1. Lock booking record
    const bookingRes = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`,
      [parsedBookingId]
    );
    const booking = bookingRes.rows[0];

    if (!booking) {
      const err = new Error('Booking not found');
      err.statusCode = 404;
      throw err;
    }

    // Permission check: Own booking only (or Admin)
    if (booking.student_id !== currentUser.id && currentUser.role !== 'ADMIN') {
      const err = new Error('Access denied: You can only cancel your own bookings');
      err.statusCode = 403;
      throw err;
    }

    if (booking.status === 'CANCELLED') {
      return { success: true, booking, alreadyCancelled: true };
    }

    // 2. Lock and release booking seats
    const seatRes = await client.query(
      `SELECT seat_id FROM booking_seats WHERE booking_id = $1 ORDER BY seat_id ASC FOR UPDATE`,
      [parsedBookingId]
    );
    const seatIds = seatRes.rows.map(r => r.seat_id);

    // Update statuses to CANCELLED
    await client.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = $1`, [parsedBookingId]);
    await client.query(`UPDATE booking_seats SET status = 'CANCELLED' WHERE booking_id = $1`, [parsedBookingId]);

    // 3. Write BOOKING_CANCELLED audit record in SAME transaction
    await writeAudit(currentUser, {
      actorId: currentUser.id,
      actorRole: currentUser.role,
      action: 'BOOKING_CANCELLED',
      eventId: booking.event_id,
      details: {
        bookingId: parsedBookingId,
        releasedSeatIds: seatIds,
      },
      client,
    });

    // 4. Broadcast real-time SSE seat update (freed seats)
    broadcastSeatUpdate(booking.event_id, {
      type: 'SEAT_UPDATE',
      seatIds,
      state: 'AVAILABLE',
    });

    // 5. Trigger waitlist processing for newly available seats
    await processWaitlist(booking.event_id, client);

    return {
      success: true,
      booking: { ...booking, status: 'CANCELLED' },
      releasedSeatIds: seatIds,
    };
  });
}

/**
 * Toggle seat blocked status (Organizer/Admin only).
 * Organizers cannot block booked seats!
 *
 * @param {object} currentUser
 * @param {number} seatId
 */
async function toggleSeatBlock(currentUser, seatId) {
  if (!currentUser || (currentUser.role !== 'ORGANIZER' && currentUser.role !== 'ADMIN')) {
    const error = new Error('Access denied: Only organizers and administrators can block seats');
    error.statusCode = 403;
    throw error;
  }

  const parsedSeatId = parseInt(seatId, 10);

  return await db.withTransaction(async (client) => {
    // 1. Lock seat and join event for ownership check
    const seatRes = await client.query(
      `SELECT s.*, e.organizer_id, e.title as event_title
       FROM seats s
       JOIN events e ON s.event_id = e.id
       WHERE s.id = $1
       FOR UPDATE`,
      [parsedSeatId]
    );
    const seat = seatRes.rows[0];

    if (!seat) {
      const err = new Error('Seat not found');
      err.statusCode = 404;
      throw err;
    }

    // Ownership check inside service
    if (currentUser.role !== 'ADMIN' && currentUser.id !== seat.organizer_id) {
      const err = new Error('Access denied: You can only block seats in your own events');
      err.statusCode = 403;
      throw err;
    }

    // If currently BLOCKED, unblock to AVAILABLE
    if (seat.status === 'BLOCKED') {
      const updated = await client.query(
        `UPDATE seats SET status = 'AVAILABLE' WHERE id = $1 RETURNING *`,
        [parsedSeatId]
      );

      broadcastSeatUpdate(seat.event_id, {
        type: 'SEAT_UPDATE',
        seatIds: [parsedSeatId],
        state: 'AVAILABLE',
      });

      return { seat: updated.rows[0], action: 'UNBLOCKED' };
    }

    // If currently AVAILABLE, check if booked (Organizers cannot block booked seats)
    const bookingCheck = await client.query(
      `SELECT bs.id FROM booking_seats bs
       JOIN bookings b ON bs.booking_id = b.id
       WHERE bs.seat_id = $1 AND b.status = 'CONFIRMED' AND bs.status = 'CONFIRMED'
       FOR UPDATE`,
      [parsedSeatId]
    );

    if (bookingCheck.rows.length > 0) {
      const err = new Error('Cannot block an already booked seat. Booked seats cannot be blocked by organizers.');
      err.statusCode = 409;
      throw err;
    }

    // Check active unexpired hold
    const holdCheck = await client.query(
      `SELECT hs.id FROM hold_seats hs
       JOIN holds h ON hs.hold_id = h.id
       WHERE hs.seat_id = $1 AND h.status = 'ACTIVE' AND h.expires_at > NOW()
       FOR UPDATE OF h`,
      [parsedSeatId]
    );

    if (holdCheck.rows.length > 0) {
      const err = new Error('Cannot block a seat with an active student hold. Wait for hold to expire or be confirmed.');
      err.statusCode = 409;
      throw err;
    }

    const updated = await client.query(
      `UPDATE seats SET status = 'BLOCKED' WHERE id = $1 RETURNING *`,
      [parsedSeatId]
    );

    broadcastSeatUpdate(seat.event_id, {
      type: 'SEAT_UPDATE',
      seatIds: [parsedSeatId],
      state: 'BLOCKED',
    });

    return { seat: updated.rows[0], action: 'BLOCKED' };
  });
}

/**
 * List bookings and active holds for current student
 *
 * @param {object} currentUser
 */
async function listMyBookings(currentUser) {
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required');
    error.statusCode = 401;
    throw error;
  }

  // Lazy cleanup of expired holds
  await cleanupExpiredHolds();

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

module.exports = {
  cleanupExpiredHolds,
  getSeatMap,
  holdSeats,
  confirmHold,
  cancelBooking,
  toggleSeatBlock,
  listMyBookings,
};
