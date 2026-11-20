const db = require('../config/db');
const { writeAudit } = require('./audit.service');

/**
 * List events filtered according to user role.
 * - ADMIN: Sees all events (published & draft) across all organizers
 * - ORGANIZER: Sees all events owned by this organizer
 * - STUDENT / PUBLIC: Sees only published events
 *
 * @param {object|null} currentUser
 * @returns {Promise<Array>}
 */
async function listEvents(currentUser) {
  let queryText = '';
  let params = [];

  if (currentUser && currentUser.role === 'ADMIN') {
    queryText = `
      SELECT e.*, u.name as organizer_name, u.email as organizer_email,
             COUNT(s.id) as total_seats
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      LEFT JOIN seats s ON s.event_id = e.id
      GROUP BY e.id, u.name, u.email
      ORDER BY e.start_time ASC;
    `;
  } else if (currentUser && currentUser.role === 'ORGANIZER') {
    queryText = `
      SELECT e.*, u.name as organizer_name, u.email as organizer_email,
             COUNT(s.id) as total_seats
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      LEFT JOIN seats s ON s.event_id = e.id
      WHERE e.organizer_id = $1
      GROUP BY e.id, u.name, u.email
      ORDER BY e.start_time ASC;
    `;
    params = [currentUser.id];
  } else {
    // Student or unauthenticated guest
    queryText = `
      SELECT e.*, u.name as organizer_name, u.email as organizer_email,
             COUNT(s.id) as total_seats
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      LEFT JOIN seats s ON s.event_id = e.id
      WHERE e.is_published = true
      GROUP BY e.id, u.name, u.email
      ORDER BY e.start_time ASC;
    `;
  }

  const result = await db.query(queryText, params);
  return result.rows;
}

/**
 * Get event by ID with server-side role check
 *
 * @param {object|null} currentUser
 * @param {number} eventId
 */
async function getEventById(currentUser, eventId) {
  const result = await db.query(
    `SELECT e.*, u.name as organizer_name, u.email as organizer_email
     FROM events e
     JOIN users u ON e.organizer_id = u.id
     WHERE e.id = $1`,
    [eventId]
  );

  const event = result.rows[0];
  if (!event) {
    const error = new Error('Event not found');
    error.statusCode = 404;
    throw error;
  }

  // Permission check inside service
  if (!event.is_published) {
    const isOwner = currentUser && (currentUser.role === 'ADMIN' || (currentUser.role === 'ORGANIZER' && currentUser.id === event.organizer_id));
    if (!isOwner) {
      const error = new Error('Access denied: You do not have permission to view this unpublished event');
      error.statusCode = 403;
      throw error;
    }
  }

  return event;
}

/**
 * Update event using optimistic locking.
 * Returns 409 conflict if version has changed.
 *
 * @param {object} currentUser
 * @param {number} eventId
 * @param {object} updates
 */
async function updateEvent(currentUser, eventId, {
  title,
  description,
  venue,
  start_time,
  is_published,
  version
}) {
  const event = await getEventById(currentUser, eventId);

  // Permission check: only admin or event organizer can update
  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.id !== event.organizer_id)) {
    const error = new Error('Access denied: You cannot edit an event you do not own');
    error.statusCode = 403;
    throw error;
  }

  const currentVersion = parseInt(version, 10);
  const nextVersion = currentVersion + 1;

  const result = await db.query(`
    UPDATE events
    SET title = COALESCE($1, title),
        description = COALESCE($2, description),
        venue = COALESCE($3, venue),
        start_time = COALESCE($4, start_time),
        is_published = COALESCE($5, is_published),
        version = $6,
        updated_at = NOW()
    WHERE id = $7 AND version = $8
    RETURNING *;
  `, [
    title,
    description,
    venue,
    start_time,
    is_published,
    nextVersion,
    eventId,
    currentVersion
  ]);

  if (result.rowCount === 0) {
    const conflictError = new Error('Conflict: Event was modified by another transaction. Please reload and try again.');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  const updatedEvent = result.rows[0];

  await writeAudit(currentUser, {
    actorId: currentUser.id,
    actorRole: currentUser.role,
    action: 'EVENT_UPDATED',
    eventId: eventId,
    details: {
      oldVersion: currentVersion,
      newVersion: nextVersion,
      title: updatedEvent.title,
      is_published: updatedEvent.is_published,
    },
  });

  return updatedEvent;
}

/**
 * Check-in attendee for an event (Service re-checks ownership)
 */
async function checkIn(currentUser, bookingId) {
  const result = await db.query(
    `SELECT b.*, e.organizer_id, e.title as event_title
     FROM bookings b
     JOIN events e ON b.event_id = e.id
     WHERE b.id = $1`,
    [bookingId]
  );

  const booking = result.rows[0];
  if (!booking) {
    const error = new Error('Booking not found');
    error.statusCode = 404;
    throw error;
  }

  // Permission check inside service
  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.id !== booking.organizer_id)) {
    const error = new Error('Access denied: You can only check in attendees for your own events');
    error.statusCode = 403;
    throw error;
  }

  if (booking.checked_in) {
    return { booking, alreadyCheckedIn: true };
  }

  const updated = await db.query(
    `UPDATE bookings SET checked_in = true, checked_in_at = NOW() WHERE id = $1 RETURNING *`,
    [bookingId]
  );

  await writeAudit(currentUser, {
    actorId: currentUser.id,
    actorRole: currentUser.role,
    action: 'CHECKIN',
    eventId: booking.event_id,
    details: { bookingId, studentId: booking.student_id },
  });

  return { booking: updated.rows[0], alreadyCheckedIn: false };
}

/**
 * List bookings for an event (Service re-checks ownership)
 */
async function listEventBookings(currentUser, eventId) {
  const event = await getEventById(currentUser, eventId);

  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.id !== event.organizer_id)) {
    const error = new Error('Access denied: You can only view attendee lists for your own events');
    error.statusCode = 403;
    throw error;
  }

  const result = await db.query(
    `SELECT b.*, u.name as student_name, u.email as student_email,
            COALESCE(json_agg(json_build_object('row', s.row_label, 'seat', s.seat_number)) FILTER (WHERE s.id IS NOT NULL), '[]') as seats
     FROM bookings b
     JOIN users u ON b.student_id = u.id
     LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     LEFT JOIN seats s ON bs.seat_id = s.id
     WHERE b.event_id = $1
     GROUP BY b.id, u.name, u.email
     ORDER BY b.created_at ASC`,
    [eventId]
  );

  return result.rows;
}

module.exports = {
  listEvents,
  getEventById,
  updateEvent,
  checkIn,
  listEventBookings,
};
