// src/services/eventService.js

const { pool } = require('../db/pool');
const { v7: uuidv7 } = require('uuid');
const { writeAudit, ForbiddenError } = require('./auditService');

class ConflictError extends Error {
  constructor(message = 'Conflict', details = {}) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.details = details;
  }
}

/**
 * Lists events filtered by role and permissions.
 */
async function listEvents(currentUser) {
  if (!currentUser || currentUser.role === 'student') {
    // Students only see published events
    const res = await pool.query(
      `SELECT e.*, u.name as organizer_name 
       FROM events e 
       JOIN users u ON e.organizer_id = u.id 
       WHERE e.status = 'published' 
       ORDER BY e.start_time ASC`
    );
    return res.rows;
  }

  if (currentUser.role === 'organizer') {
    // Organizers see all published events + their own drafts/cancelled
    const res = await pool.query(
      `SELECT e.*, u.name as organizer_name 
       FROM events e 
       JOIN users u ON e.organizer_id = u.id 
       WHERE e.status = 'published' OR e.organizer_id = $1 
       ORDER BY e.start_time ASC`,
      [currentUser.id]
    );
    return res.rows;
  }

  // Admin sees all events
  const res = await pool.query(
    `SELECT e.*, u.name as organizer_name 
     FROM events e 
     JOIN users u ON e.organizer_id = u.id 
     ORDER BY e.start_time ASC`
  );
  return res.rows;
}

/**
 * Gets a single event by ID with access check for draft events.
 */
async function getEventById(currentUser, eventId) {
  const res = await pool.query(
    `SELECT e.*, u.name as organizer_name 
     FROM events e 
     JOIN users u ON e.organizer_id = u.id 
     WHERE e.id = $1`,
    [eventId]
  );

  const event = res.rows[0];
  if (!event) return null;

  if (event.status !== 'published') {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.id !== event.organizer_id)) {
      throw new ForbiddenError('You do not have permission to view this unpublished event.');
    }
  }

  return event;
}

/**
 * Creates a new event with seat grid.
 */
async function createEvent(currentUser, data) {
  if (!currentUser || (currentUser.role !== 'organizer' && currentUser.role !== 'admin')) {
    throw new ForbiddenError('Only organizers and admins can create events.');
  }

  const id = uuidv7();
  const organizerId = currentUser.role === 'admin' && data.organizer_id ? data.organizer_id : currentUser.id;

  const res = await pool.query(
    `INSERT INTO events 
       (id, title, description, venue, start_time, end_time, status, organizer_id, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now(), now())
     RETURNING *`,
    [
      id,
      data.title,
      data.description || '',
      data.venue,
      new Date(data.start_time),
      new Date(data.end_time),
      data.status || 'published',
      organizerId,
    ]
  );

  const event = res.rows[0];

  // Auto-generate standard 50-seat grid (Rows A-E, 1-10)
  const rows = ['A', 'B', 'C', 'D', 'E'];
  for (const row of rows) {
    for (let col = 1; col <= 10; col++) {
      const seatId = uuidv7();
      const seatNumber = `${row}${col}`;
      await pool.query(
        `INSERT INTO seats (id, event_id, seat_number, row_name, seat_col, is_blocked)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [seatId, id, seatNumber, row, col]
      );
    }
  }

  await writeAudit({
    eventId: id,
    actorId: currentUser.id,
    action: 'EVENT_UPDATED',
    details: { change: 'created', title: event.title }
  });

  return event;
}

/**
 * Updates an event using optimistic locking with the version field.
 */
async function updateEvent(currentUser, eventId, data) {
  // Check existence and ownership
  const currentRes = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  const currentEvent = currentRes.rows[0];

  if (!currentEvent) {
    throw new Error('Event not found.');
  }

  // Permission check: Admin or owning Organizer
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.id !== currentEvent.organizer_id)) {
    throw new ForbiddenError('Organizers may modify only their own events.');
  }

  const submittedVersion = parseInt(data.version, 10);
  if (isNaN(submittedVersion)) {
    throw new Error('Missing or invalid event version for optimistic locking.');
  }

  const updateRes = await pool.query(
    `UPDATE events 
     SET title = $1, description = $2, venue = $3, start_time = $4, end_time = $5, status = $6,
         version = version + 1, updated_at = now()
     WHERE id = $7 AND version = $8
     RETURNING *`,
    [
      data.title,
      data.description || '',
      data.venue,
      new Date(data.start_time),
      new Date(data.end_time),
      data.status || 'published',
      eventId,
      submittedVersion,
    ]
  );

  if (updateRes.rows.length === 0) {
    // 0 rows updated means concurrent modification!
    throw new ConflictError(
      'Optimistic lock failed: The event has been modified by another transaction. Please reload and retry.',
      { eventId, expectedVersion: submittedVersion }
    );
  }

  const updatedEvent = updateRes.rows[0];

  await writeAudit({
    eventId,
    actorId: currentUser.id,
    action: 'EVENT_UPDATED',
    details: {
      previousVersion: submittedVersion,
      newVersion: updatedEvent.version,
      title: updatedEvent.title
    }
  });

  return updatedEvent;
}

/**
 * Blocks or unblocks a seat for an event. Organizers cannot block booked seats.
 */
async function blockSeat(currentUser, { eventId, seatId, isBlocked }) {
  const event = await getEventById(currentUser, eventId);
  if (!event) throw new Error('Event not found.');

  if (!currentUser || (currentUser.role !== 'admin' && currentUser.id !== event.organizer_id)) {
    throw new ForbiddenError('You can only manage seats for your own events.');
  }

  if (isBlocked) {
    // Check if seat is currently booked: "Organizers cannot block booked seats"
    const bookedCheck = await pool.query(
      `SELECT bs.id 
       FROM booking_seats bs 
       JOIN bookings b ON bs.booking_id = b.id 
       WHERE bs.seat_id = $1 AND bs.status = 'ACTIVE'`,
      [seatId]
    );

    if (bookedCheck.rows.length > 0) {
      throw new ConflictError('Cannot block a booked seat.');
    }
  }

  const updateRes = await pool.query(
    'UPDATE seats SET is_blocked = $1 WHERE id = $2 AND event_id = $3 RETURNING *',
    [Boolean(isBlocked), seatId, eventId]
  );

  return updateRes.rows[0];
}

/**
 * Lists attendees/bookings for an event.
 */
async function listEventBookings(currentUser, eventId) {
  const event = await getEventById(currentUser, eventId);
  if (!event) throw new Error('Event not found.');

  if (!currentUser || (currentUser.role !== 'admin' && currentUser.id !== event.organizer_id)) {
    throw new ForbiddenError('You may only view attendees for your own events.');
  }

  const res = await pool.query(
    `SELECT b.id as booking_id, b.status as booking_status, b.is_checked_in, b.checked_in_at, b.created_at,
            u.id as user_id, u.name as attendee_name, u.email as attendee_email,
            COALESCE(
              json_agg(json_build_object('seat_id', s.id, 'seat_number', s.seat_number)) 
              FILTER (WHERE s.id IS NOT NULL), '[]'
            ) as seats
     FROM bookings b
     JOIN users u ON b.user_id = u.id
     JOIN booking_seats bs ON bs.booking_id = b.id
     JOIN seats s ON bs.seat_id = s.id
     WHERE b.event_id = $1 AND bs.status = 'ACTIVE'
     GROUP BY b.id, u.id
     ORDER BY b.created_at DESC`,
    [eventId]
  );

  return { event, attendees: res.rows };
}

/**
 * Checks in an attendee.
 */
async function checkIn(currentUser, { eventId, bookingId }) {
  const event = await getEventById(currentUser, eventId);
  if (!event) throw new Error('Event not found.');

  if (!currentUser || (currentUser.role !== 'admin' && currentUser.id !== event.organizer_id)) {
    throw new ForbiddenError('You may only check in attendees for your own events.');
  }

  const res = await pool.query(
    `UPDATE bookings 
     SET is_checked_in = true, checked_in_at = now() 
     WHERE id = $1 AND event_id = $2 
     RETURNING *`,
    [bookingId, eventId]
  );

  if (res.rows.length === 0) {
    throw new Error('Booking not found for this event.');
  }

  await writeAudit({
    eventId,
    actorId: currentUser.id,
    action: 'CHECKIN',
    details: { bookingId, checkedInBy: currentUser.id }
  });

  return res.rows[0];
}

module.exports = {
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  blockSeat,
  listEventBookings,
  checkIn,
  ConflictError,
};
