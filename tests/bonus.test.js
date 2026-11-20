const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const {
  holdSeats,
  confirmHold,
  cancelBooking,
  getSeatMap,
  cleanupExpiredHolds,
} = require('../src/services/booking.service');
const {
  joinWaitlist,
  leaveWaitlist,
  getStudentWaitlistStatus,
  processWaitlist,
} = require('../src/services/waitlist.service');
const { seatEvents, broadcastSeatUpdate } = require('../src/utils/seatEvents');

test('Bonus Track: Idempotency, Live SSE Updates, Waitlist, and NOWAIT/SKIP LOCKED', async (t) => {
  t.after(async () => {
    await db.pool.end();
  });

  const eventRes = await db.query("SELECT id FROM events WHERE is_published = true ORDER BY id ASC LIMIT 1");
  const eventId = eventRes.rows[0].id;

  const studentRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'student@collegefest.edu'");
  const student = studentRes.rows[0];

  const student2Res = await db.query("SELECT id, name, email, role FROM users WHERE email = 'priya@collegefest.edu'");
  const student2 = student2Res.rows[0];

  await t.test('1. BONUS 1: Idempotent confirmHold with Idempotency Key', async () => {
    // Pick seat C10
    const seatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'C' AND seat_number = 10", [eventId]);
    const seatId = seatRes.rows[0].id;

    // Reset seat state
    await db.query("DELETE FROM booking_seats WHERE seat_id = $1", [seatId]);
    await db.query("DELETE FROM hold_seats WHERE seat_id = $1", [seatId]);
    await db.query("UPDATE seats SET status = 'AVAILABLE' WHERE id = $1", [seatId]);

    // Hold seat
    const holdRes = await holdSeats(student, eventId, [seatId]);
    const holdId = holdRes.hold.id;

    const idempotencyKey = `idemp-key-${Date.now()}-${Math.random()}`;

    // First confirmation with key
    const confirm1 = await confirmHold(student, holdId, { idempotencyKey });
    assert.equal(confirm1.success, true);
    assert.equal(confirm1.idempotent, false, 'First confirmation must execute transaction');
    assert.equal(confirm1.booking.status, 'CONFIRMED');

    // Repeated confirmation with SAME idempotency key (simulating network retry)
    const confirm2 = await confirmHold(student, holdId, { idempotencyKey });
    assert.equal(confirm2.success, true);
    assert.equal(confirm2.idempotent, true, 'Second confirmation with same key must return existing booking');
    assert.equal(confirm2.booking.id, confirm1.booking.id, 'Must return identical booking record');

    // Repeated confirmation on already CONFIRMED hold without key
    const confirm3 = await confirmHold(student, holdId);
    assert.equal(confirm3.success, true);
    assert.equal(confirm3.idempotent, true, 'Calling confirm on confirmed hold must be safe & idempotent');
  });

  await t.test('2. BONUS 2: Live Seat-Map Refresh via Real-Time SSE Event Emitter', (t, done) => {
    const testSeatIds = [99991, 99992];
    const targetState = 'BOOKED';

    // Register SSE subscriber
    const listener = (payload) => {
      assert.equal(payload.type, 'SEAT_UPDATE');
      assert.deepEqual(payload.seatIds, testSeatIds);
      assert.equal(payload.state, targetState);
      seatEvents.off(`seat-update:${eventId}`, listener);
      done();
    };

    seatEvents.on(`seat-update:${eventId}`, listener);

    // Broadcast test update
    broadcastSeatUpdate(eventId, {
      type: 'SEAT_UPDATE',
      seatIds: testSeatIds,
      state: targetState,
    });
  });

  await t.test('3. BONUS 3: Event Waitlist Lifecycle', async () => {
    // Student 2 joins waitlist for 2 seats
    await leaveWaitlist(student2, eventId); // clean start
    const entry = await joinWaitlist(student2, eventId, 2);
    assert.equal(entry.status, 'WAITING');
    assert.equal(entry.requested_seats_count, 2);

    // Check status
    const status = await getStudentWaitlistStatus(student2, eventId);
    assert.ok(status, 'Student must be on waitlist');
    assert.equal(status.status, 'WAITING');

    // Process waitlist: Simulates notification when a seat becomes free
    const notified = await processWaitlist(eventId);
    assert.ok(notified, 'Waitlist processor should notify waiting student');
    assert.equal(notified.student_id, student2.id);

    // Cleanup
    await leaveWaitlist(student2, eventId);
    const afterLeave = await getStudentWaitlistStatus(student2, eventId);
    assert.equal(afterLeave, null, 'Student should no longer be on waitlist');
  });

  await t.test('4. BONUS 4: NOWAIT / SKIP LOCKED Concurrency Variants', async () => {
    // Pick seat C9
    const seatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'C' AND seat_number = 9", [eventId]);
    const seatId = seatRes.rows[0].id;

    // Reset seat state
    await db.query("DELETE FROM booking_seats WHERE seat_id = $1", [seatId]);
    await db.query("DELETE FROM hold_seats WHERE seat_id = $1", [seatId]);
    await db.query("UPDATE seats SET status = 'AVAILABLE' WHERE id = $1", [seatId]);

    // Test NOWAIT: When no contention, NOWAIT succeeds immediately
    const holdRes = await holdSeats(student, eventId, [seatId], { lockingMode: 'NOWAIT' });
    assert.equal(holdRes.success, true);

    // Test SKIP LOCKED in hold cleanup: Verify non-blocking execution
    const swept = await cleanupExpiredHolds();
    assert.ok(typeof swept === 'number', 'cleanupExpiredHolds with SKIP LOCKED must run without error');
  });
});
