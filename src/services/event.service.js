const db = require('../config/db');
const { writeAudit } = require('./audit.service');
const { deleteEventPhoto } = require('../utils/eventPhotos');

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
      if (currentUser) {
        await writeAudit(currentUser, {
          action: 'ACCESS_DENIED',
          eventId: event.id,
          details: { reason: 'Unauthorized access to unpublished event' },
        });
      }
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
  end_time,
  is_published,
  theme_photo,
  version
}) {
  const event = await getEventById(currentUser, eventId);

  // Permission check: only admin or event organizer can update
  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.id !== event.organizer_id)) {
    await writeAudit(currentUser, {
      action: 'ACCESS_DENIED',
      eventId: event.id,
      details: { reason: 'Unauthorized event edit attempt' },
    });
    const error = new Error('Access denied: You cannot edit an event you do not own');
    error.statusCode = 403;
    throw error;
  }

  const currentVersion = parseInt(version, 10);
  const nextVersion = currentVersion + 1;
  const nextStart = start_time || event.start_time;
  const nextEnd = end_time || event.end_time;
  if (!nextEnd || !Number.isFinite(new Date(nextEnd).getTime()) || new Date(nextEnd) <= new Date(nextStart)) {
    const error = new Error('Event end date and time must be after the start date and time.');
    error.statusCode = 400;
    throw error;
  }

  const result = await db.query(`
    UPDATE events
    SET title = COALESCE($1, title),
        description = COALESCE($2, description),
        venue = COALESCE($3, venue),
        start_time = COALESCE($4, start_time),
        end_time = COALESCE($5, end_time),
        is_published = COALESCE($6, is_published),
        theme_photo = COALESCE($7, theme_photo),
        version = $8,
        updated_at = NOW()
    WHERE id = $9 AND version = $10
    RETURNING *;
  `, [
    title,
    description,
    venue,
    start_time,
    end_time,
    is_published,
    theme_photo,
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

/** Create an event and its seats atomically for an admin or organizer. */
async function createEvent(currentUser, {
  title,
  description,
  venue,
  start_time,
  end_time,
  is_published,
  theme_photo,
  row_count,
  seats_per_row,
}) {
  if (!currentUser || !['ADMIN', 'ORGANIZER'].includes(currentUser.role)) {
    const error = new Error('Only admins and organizers can create events.');
    error.statusCode = 403;
    throw error;
  }

  const normalizedTitle = (title || '').trim();
  const normalizedVenue = (venue || '').trim();
  const normalizedDescription = (description || '').trim();
  const startTime = start_time ? new Date(start_time) : null;
  const endTime = end_time ? new Date(end_time) : null;
  const rows = Number(row_count);
  const seatsPerRow = Number(seats_per_row);

  if (!normalizedTitle || normalizedTitle.length > 200) {
    const error = new Error('Enter an event title (up to 200 characters).');
    error.statusCode = 400;
    throw error;
  }
  if (!normalizedVenue || normalizedVenue.length > 200) {
    const error = new Error('Enter a venue (up to 200 characters).');
    error.statusCode = 400;
    throw error;
  }
  if (normalizedDescription.length > 5000) {
    const error = new Error('Description must be 5,000 characters or fewer.');
    error.statusCode = 400;
    throw error;
  }
  if (!startTime || !Number.isFinite(startTime.getTime())) {
    const error = new Error('Enter a valid event date and time.');
    error.statusCode = 400;
    throw error;
  }
  if (!endTime || !Number.isFinite(endTime.getTime()) || endTime <= startTime) {
    const error = new Error('Enter an event end date and time after its start.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 26 || !Number.isInteger(seatsPerRow) || seatsPerRow < 1 || seatsPerRow > 100) {
    const error = new Error('Choose 1–26 rows and 1–100 seats per row.');
    error.statusCode = 400;
    throw error;
  }

  return db.withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO events (title, description, venue, start_time, end_time, is_published, organizer_id, theme_photo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [normalizedTitle, normalizedDescription || null, normalizedVenue, startTime, endTime, Boolean(is_published), currentUser.id, theme_photo || null]
    );
    const event = result.rows[0];

    await client.query(
      `INSERT INTO seats (event_id, row_label, seat_number)
       SELECT $1, chr(64 + rows.row_num)::varchar, seat_numbers.seat_num
       FROM generate_series(1, $2) AS rows(row_num)
       CROSS JOIN generate_series(1, $3) AS seat_numbers(seat_num)`,
      [event.id, rows, seatsPerRow]
    );

    await writeAudit(client, {
      actorId: currentUser.id,
      actorRole: currentUser.role,
      action: 'EVENT_CREATED',
      eventId: event.id,
      details: {
        title: event.title,
        is_published: event.is_published,
        seatCount: rows * seatsPerRow,
      },
    });

    return event;
  });
}

async function deleteEvent(currentUser, eventId) {
  if (!currentUser || currentUser.role !== 'ADMIN') {
    const error = new Error('Only admins can delete events.');
    error.statusCode = 403;
    throw error;
  }
  const deletedEvent = await db.withTransaction(async (client) => {
    const result = await client.query('SELECT id, title, theme_photo FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const event = result.rows[0];
    if (!event) {
      const error = new Error('Event not found');
      error.statusCode = 404;
      throw error;
    }
    await writeAudit(currentUser, {
      action: 'EVENT_DELETED', eventId: event.id,
      details: { title: event.title, deletedByAdmin: true }, client,
    });
    await client.query('DELETE FROM events WHERE id = $1', [event.id]);
    return event;
  });
  await deleteEventPhoto(deletedEvent.theme_photo).catch(() => {});
  return deletedEvent;
}

async function deleteExpiredEvents() {
  const expiredEvents = await db.withTransaction(async (client) => {
    const expired = await client.query(
      `SELECT id, title, end_time, theme_photo FROM events
       WHERE end_time <= NOW()
       ORDER BY id ASC
       FOR UPDATE SKIP LOCKED`
    );
    for (const event of expired.rows) {
      await writeAudit(null, {
        actorId: null,
        actorRole: 'SYSTEM',
        action: 'EVENT_AUTO_DELETED',
        eventId: event.id,
        details: { title: event.title, endTime: event.end_time },
        client,
      });
      await client.query('DELETE FROM events WHERE id = $1', [event.id]);
    }
    return expired.rows;
  });
  await Promise.all(expiredEvents.map(event => deleteEventPhoto(event.theme_photo).catch(() => {})));
  return expiredEvents.length;
}

/**
 * Check-in attendee for an event (Service re-checks ownership and writes CHECKIN / ACCESS_DENIED)
 *
 * - Organizers may only check in attendees for their OWN events.
 * - Admins may check in attendees for any event.
 * - Students are denied (403 + ACCESS_DENIED).
 *
 * @param {object} currentUser
 * @param {number} bookingId
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

  // Permission check: Admin or Organizer owning this event
  const isAuthorized = currentUser && (
    currentUser.role === 'ADMIN' ||
    (currentUser.role === 'ORGANIZER' && currentUser.id === booking.organizer_id)
  );

  if (!isAuthorized) {
    await writeAudit(currentUser, {
      actorId: currentUser ? currentUser.id : null,
      actorRole: currentUser ? currentUser.role : 'ANONYMOUS',
      action: 'ACCESS_DENIED',
      eventId: booking.event_id,
      details: {
        reason: 'Ownership violation: Organizer attempted check-in for an event owned by another organizer',
        bookingId,
        bookingOrganizerId: booking.organizer_id,
        currentUserId: currentUser ? currentUser.id : null,
      },
    });

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

  // Log CHECKIN action
  await writeAudit(currentUser, {
    actorId: currentUser.id,
    actorRole: currentUser.role,
    action: 'CHECKIN',
    eventId: booking.event_id,
    details: {
      bookingId,
      studentId: booking.student_id,
      checkedInAt: updated.rows[0].checked_in_at,
    },
  });

  return { booking: updated.rows[0], alreadyCheckedIn: false };
}

/**
 * List bookings for an event (Service re-checks ownership and writes ACCESS_DENIED on violation)
 *
 * - Organizers may only access their OWN events.
 * - Admins may access all events.
 * - Students are denied (403 + ACCESS_DENIED).
 *
 * @param {object} currentUser
 * @param {number} eventId
 */
async function listEventBookings(currentUser, eventId) {
  // First retrieve event to inspect organizer_id
  const eventRes = await db.query(`SELECT * FROM events WHERE id = $1`, [eventId]);
  const event = eventRes.rows[0];

  if (!event) {
    const error = new Error('Event not found');
    error.statusCode = 404;
    throw error;
  }

  const isAuthorized = currentUser && (
    currentUser.role === 'ADMIN' ||
    (currentUser.role === 'ORGANIZER' && currentUser.id === event.organizer_id)
  );

  if (!isAuthorized) {
    await writeAudit(currentUser, {
      actorId: currentUser ? currentUser.id : null,
      actorRole: currentUser ? currentUser.role : 'ANONYMOUS',
      action: 'ACCESS_DENIED',
      eventId: event.id,
      details: {
        reason: 'Ownership violation: Organizer attempted to view attendee roster of another organizer\'s event',
        eventOrganizerId: event.organizer_id,
        currentUserId: currentUser ? currentUser.id : null,
      },
    });

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
     WHERE b.event_id = $1 AND b.status = 'CONFIRMED'
     GROUP BY b.id, u.name, u.email
     ORDER BY b.created_at ASC`,
    [eventId]
  );

  return result.rows;
}

module.exports = {
  listEvents,
  getEventById,
  createEvent,
  deleteEvent,
  deleteExpiredEvents,
  updateEvent,
  checkIn,
  listEventBookings,
};
