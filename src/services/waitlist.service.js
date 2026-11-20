const db = require('../config/db');
const { writeAudit } = require('./audit.service');

/**
 * Join event waitlist (Students/Admins only)
 *
 * @param {object} currentUser
 * @param {number} eventId
 * @param {number} requestedSeatsCount
 */
async function joinWaitlist(currentUser, eventId, requestedSeatsCount = 1) {
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required to join waitlist');
    error.statusCode = 401;
    throw error;
  }

  if (currentUser.role !== 'STUDENT' && currentUser.role !== 'ADMIN') {
    const error = new Error('Access denied: Only students can join event waitlists');
    error.statusCode = 403;
    throw error;
  }

  const parsedEventId = parseInt(eventId, 10);
  const seatsCount = Math.min(Math.max(parseInt(requestedSeatsCount, 10) || 1, 1), 4);

  // Check if student already has a confirmed booking or active hold
  const activeHold = await db.query(
    `SELECT id FROM holds WHERE student_id = $1 AND event_id = $2 AND status = 'ACTIVE' AND expires_at > NOW()`,
    [currentUser.id, parsedEventId]
  );
  if (activeHold.rows.length > 0) {
    const error = new Error('You already have an active seat hold for this event');
    error.statusCode = 409;
    throw error;
  }

  // Insert or update waitlist entry
  const result = await db.query(
    `INSERT INTO waitlist (event_id, student_id, requested_seats_count, status)
     VALUES ($1, $2, $3, 'WAITING')
     ON CONFLICT (event_id, student_id)
     DO UPDATE SET status = 'WAITING', requested_seats_count = EXCLUDED.requested_seats_count, created_at = NOW()
     RETURNING *`,
    [parsedEventId, currentUser.id, seatsCount]
  );

  return result.rows[0];
}

/**
 * Leave event waitlist
 *
 * @param {object} currentUser
 * @param {number} eventId
 */
async function leaveWaitlist(currentUser, eventId) {
  if (!currentUser) {
    const error = new Error('Access denied: Authentication required');
    error.statusCode = 401;
    throw error;
  }

  const parsedEventId = parseInt(eventId, 10);

  const result = await db.query(
    `DELETE FROM waitlist WHERE event_id = $1 AND student_id = $2 RETURNING *`,
    [parsedEventId, currentUser.id]
  );

  return { success: true, removed: result.rowCount > 0 };
}

/**
 * Get waitlist status for current student on an event
 */
async function getStudentWaitlistStatus(currentUser, eventId) {
  if (!currentUser) return null;
  const result = await db.query(
    `SELECT * FROM waitlist WHERE event_id = $1 AND student_id = $2 AND status = 'WAITING'`,
    [parseInt(eventId, 10), currentUser.id]
  );
  return result.rows[0] || null;
}

/**
 * Process waitlist: notified when seats are freed up
 */
async function processWaitlist(eventId, client = null) {
  const executor = client || db;

  // Pick earliest waiting student using SKIP LOCKED to avoid blocking
  const waitlistRes = await executor.query(
    `SELECT * FROM waitlist
     WHERE event_id = $1 AND status = 'WAITING'
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [eventId]
  );

  if (waitlistRes.rows.length === 0) return null;

  const candidate = waitlistRes.rows[0];
  await executor.query(
    `UPDATE waitlist SET status = 'NOTIFIED' WHERE id = $1`,
    [candidate.id]
  );

  return candidate;
}

module.exports = {
  joinWaitlist,
  leaveWaitlist,
  getStudentWaitlistStatus,
  processWaitlist,
};
