const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { getAuditShard } = require('../src/utils/sharding');
const { listEventBookings, checkIn } = require('../src/services/event.service');
const { holdSeats, confirmHold } = require('../src/services/booking.service');

test('Phase 4: Resource Ownership Enforcement and Attendee Check-In Tests', async (t) => {
  t.after(async () => {
    await db.pool.end();
  });

  // Fetch test users
  const adminRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'admin@collegefest.edu'");
  const adminUser = adminRes.rows[0];

  const orgARes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'organizer@collegefest.edu'");
  const organizerA = orgARes.rows[0];

  const orgBRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'sports@collegefest.edu'");
  const organizerB = orgBRes.rows[0];

  const studentRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'student@collegefest.edu'");
  const studentUser = studentRes.rows[0];

  // Fetch Event 1 (owned by Organizer A) and Event 3 (owned by Organizer B)
  const ev1Res = await db.query("SELECT id, title, organizer_id FROM events WHERE organizer_id = $1 ORDER BY id ASC LIMIT 1", [organizerA.id]);
  const eventA = ev1Res.rows[0];
  assert.equal(eventA.organizer_id, organizerA.id);

  const ev2Res = await db.query("SELECT id, title, organizer_id FROM events WHERE organizer_id = $1 ORDER BY id ASC LIMIT 1", [organizerB.id]);
  const eventB = ev2Res.rows[0];
  assert.equal(eventB.organizer_id, organizerB.id);

  // Ensure eventA has a clean, available seat for this test
  await db.query("UPDATE holds SET status = 'RELEASED' WHERE event_id = $1", [eventA.id]);
  const seatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 ORDER BY id ASC LIMIT 1", [eventA.id]);
  assert.ok(seatRes.rows.length > 0, 'Event A must have seats');
  const seatAId = seatRes.rows[0].id;

  // Clear any existing booking on this seat
  await db.query("DELETE FROM booking_seats WHERE seat_id = $1", [seatAId]);
  await db.query("UPDATE seats SET status = 'AVAILABLE' WHERE id = $1", [seatAId]);

  // Create confirmed booking in Event A
  const holdA = await holdSeats(studentUser, eventA.id, [seatAId]);
  const bookingAConfirm = await confirmHold(studentUser, holdA.hold.id);
  const bookingA = bookingAConfirm.booking;

  await t.test('1. Service Ownership: Organizer A can list bookings for own event', async () => {
    const bookings = await listEventBookings(organizerA, eventA.id);
    assert.ok(Array.isArray(bookings), 'Must return array of bookings');
    const found = bookings.find(b => b.id === bookingA.id);
    assert.ok(found, 'Booking A must be in attendee list');
    assert.equal(found.student_name, studentUser.name);
  });

  await t.test('2. Service Ownership Violation: Organizer B cannot list bookings for Organizer A\'s event (Throws 403 + ACCESS_DENIED)', async () => {
    await assert.rejects(
      async () => {
        await listEventBookings(organizerB, eventA.id);
      },
      (err) => {
        assert.equal(err.statusCode, 403, 'Must throw 403 Forbidden');
        assert.match(err.message, /Access denied/);
        return true;
      }
    );

    // Verify ACCESS_DENIED audit record was written
    const shard = getAuditShard(eventA.id, organizerB.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard}
       WHERE action = 'ACCESS_DENIED' AND actor_id = $1 AND event_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [organizerB.id, eventA.id]
    );
    assert.ok(auditRes.rows.length > 0, 'ACCESS_DENIED record must be written for ownership violation');
  });

  await t.test('3. Service Ownership: Students are denied from viewing attendee lists (Throws 403 + ACCESS_DENIED)', async () => {
    await assert.rejects(
      async () => {
        await listEventBookings(studentUser, eventA.id);
      },
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  await t.test('4. Service Ownership: Admins can list bookings for ANY event', async () => {
    const bookingsA = await listEventBookings(adminUser, eventA.id);
    assert.ok(bookingsA.length > 0, 'Admin can view Organizer A event');

    const bookingsB = await listEventBookings(adminUser, eventB.id);
    assert.ok(Array.isArray(bookingsB), 'Admin can view Organizer B event');
  });

  await t.test('5. Check-In Ownership Violation: Organizer B cannot check in attendee for Organizer A\'s event (Throws 403 + ACCESS_DENIED)', async () => {
    await assert.rejects(
      async () => {
        await checkIn(organizerB, bookingA.id);
      },
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /own events/i);
        return true;
      }
    );

    // Verify ACCESS_DENIED audit log
    const shard = getAuditShard(eventA.id, organizerB.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard}
       WHERE action = 'ACCESS_DENIED' AND actor_id = $1 AND event_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [organizerB.id, eventA.id]
    );
    assert.ok(auditRes.rows.length > 0, 'ACCESS_DENIED must be written when non-owner organizer attempts check-in');
  });

  await t.test('6. Check-In Success: Organizer A successfully checks in attendee and logs CHECKIN', async () => {
    const result = await checkIn(organizerA, bookingA.id);
    assert.equal(result.alreadyCheckedIn, false);
    assert.equal(result.booking.checked_in, true);
    assert.ok(result.booking.checked_in_at);

    // Verify CHECKIN audit record written in eventA shard
    const shard = getAuditShard(eventA.id, organizerA.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard}
       WHERE action = 'CHECKIN' AND actor_id = $1 AND event_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [organizerA.id, eventA.id]
    );
    assert.ok(auditRes.rows.length > 0, 'CHECKIN audit row must exist in target shard');
    assert.equal(auditRes.rows[0].details.bookingId, bookingA.id);

    // Verify idempotency on second call
    const secondCall = await checkIn(organizerA, bookingA.id);
    assert.equal(secondCall.alreadyCheckedIn, true);
  });

  await t.test('7. End-to-End Route Ownership: Organizer B touching Organizer A URL returns HTTP 403 SSR page', async () => {
    // Log in as Organizer B
    const getLogin = await request(app).get('/login');
    const csrfMatch = getLogin.text.match(/name="_csrf" value="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    const initialCookie = getLogin.headers['set-cookie'];

    const loginRes = await request(app)
      .post('/login')
      .set('Cookie', initialCookie)
      .send({
        _csrf: csrfToken,
        email: 'sports@collegefest.edu', // Organizer B
        password: 'Password123!',
      });

    const orgBCookie = loginRes.headers['set-cookie'];

    // Organizer B attempts to visit /organizer/events/{eventA.id}/attendees
    const res = await request(app)
      .get(`/organizer/events/${eventA.id}/attendees`)
      .set('Cookie', orgBCookie);

    assert.equal(res.status, 403, 'Must return HTTP 403 when Organizer B visits Organizer A URL');
    assert.match(res.text, /403/);
    assert.match(res.text, /Access Denied/i);
    assert.match(res.text, /Organizers may only access and manage their own events/i);
  });
});
