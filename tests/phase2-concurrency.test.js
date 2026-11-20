const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/config/db');
const {
  holdSeats,
  confirmHold,
  cancelBooking,
  toggleSeatBlock,
  getSeatMap,
} = require('../src/services/booking.service');
const { updateEvent, getEventById } = require('../src/services/event.service');

test('Phase 2: Concurrency, Row Locking, Hold Confirmation, and Optimistic Locking', async (t) => {
  t.after(async () => {
    await db.pool.end();
  });

  const passwordHash = await bcrypt.hash('Password123!', 8);
  const eventRes = await db.query("SELECT id FROM events WHERE title LIKE 'Battle of the Bands%' ORDER BY id ASC LIMIT 1");
  const eventId = eventRes.rows[0].id;

  // Create 20 test students for high-concurrency contention test
  const students = [];
  for (let i = 1; i <= 20; i++) {
    const email = `concurrent_student_${i}_${Date.now()}@test.edu`;
    const res = await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'STUDENT')
       RETURNING id, name, email, role`,
      [`Concurrent Student ${i}`, email, passwordHash]
    );
    students.push(res.rows[0]);
  }

  // Get Organizer user
  const orgRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'organizer@collegefest.edu'");
  const organizerUser = orgRes.rows[0];

  // Pick a fresh seat for the 20-way concurrency race
  const seatRes = await db.query(
    `SELECT id, row_label, seat_number FROM seats
     WHERE event_id = $1 AND row_label = 'C' AND seat_number = 5`,
    [eventId]
  );
  const targetSeat = seatRes.rows[0];
  assert.ok(targetSeat, 'Target seat C5 must exist');

  // Reset target seat state for test idempotency
  await db.query('DELETE FROM booking_seats WHERE seat_id = $1', [targetSeat.id]);
  await db.query('DELETE FROM hold_seats WHERE seat_id = $1', [targetSeat.id]);
  await db.query("UPDATE seats SET status = 'AVAILABLE' WHERE id = $1", [targetSeat.id]);

  await t.test('1. ACCEPTANCE TEST: 20 simultaneous requests for ONE seat produce exactly 1 success and 19 conflicts', async () => {
    console.log(`\nLaunching 20 simultaneous hold requests for Seat ${targetSeat.row_label}${targetSeat.seat_number} (ID: ${targetSeat.id})...`);

    // Fire all 20 requests concurrently in parallel
    const holdPromises = students.map((student) =>
      holdSeats(student, eventId, [targetSeat.id])
    );

    const results = await Promise.allSettled(holdPromises);

    let successes = 0;
    let conflicts = 0;
    let winnerStudentId = null;

    results.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        successes++;
        winnerStudentId = students[idx].id;
      } else {
        conflicts++;
        const err = res.reason;
        // Status code must be 409 (Conflict) or 503 (Lock timeout)
        assert.ok(
          err.statusCode === 409 || err.statusCode === 503,
          `Expected 409 or 503, got ${err.statusCode}: ${err.message}`
        );
      }
    });

    console.log(`Results: ${successes} Successes, ${conflicts} Conflicts.`);

    // Strict acceptance criteria
    assert.equal(successes, 1, 'Exactly ONE student must win the contested seat hold');
    assert.equal(conflicts, 19, 'Exactly NINETEEN students must receive conflict / lock rejection');

    // Verify in database that only ONE active hold exists for this seat
    const dbHoldRes = await db.query(
      `SELECT h.id, h.student_id, h.status
       FROM hold_seats hs
       JOIN holds h ON hs.hold_id = h.id
       WHERE hs.seat_id = $1 AND h.status = 'ACTIVE'`,
      [targetSeat.id]
    );

    assert.equal(dbHoldRes.rows.length, 1, 'Database must have exactly 1 active hold for contested seat');
    assert.equal(dbHoldRes.rows[0].student_id, winnerStudentId, 'Winning hold belongs to the winning student');
  });

  await t.test('2. Multi-seat Hold: All-or-Nothing validation identifies unavailable seat IDs', async () => {
    // Student 1 tries to hold 2 seats: C5 (already held above) and C6 (available)
    const seat6Res = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'C' AND seat_number = 6", [eventId]);
    const seat6Id = seat6Res.rows[0].id;

    // Student 2 attempts all-or-nothing hold on [C5, C6]
    await assert.rejects(
      async () => {
        await holdSeats(students[1], eventId, [targetSeat.id, seat6Id]);
      },
      (err) => {
        assert.equal(err.statusCode, 409, 'Must return 409 on unavailable seat in multi-seat hold');
        assert.ok(Array.isArray(err.unavailableSeatIds), 'Must return list of unavailable seat IDs');
        assert.ok(err.unavailableSeatIds.includes(targetSeat.id), 'Unavailable list must identify contested seat');
        return true;
      }
    );

    // Verify that C6 was NOT held (atomic all-or-nothing guarantee)
    const seat6HoldCheck = await db.query(
      `SELECT hs.id FROM hold_seats hs
       JOIN holds h ON hs.hold_id = h.id
       WHERE hs.seat_id = $1 AND h.status = 'ACTIVE'`,
      [seat6Id]
    );
    assert.equal(seat6HoldCheck.rows.length, 0, 'Seat C6 must remain unheld when all-or-nothing fails');
  });

  await t.test('3. Hold Replacement: Student requesting new hold replaces their previous active hold', async () => {
    // Reset Row A seats for test idempotency
    await db.query(`DELETE FROM booking_seats WHERE seat_id IN (SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A')`, [eventId]);
    await db.query(`DELETE FROM hold_seats WHERE seat_id IN (SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A')`, [eventId]);
    await db.query(`UPDATE seats SET status = 'AVAILABLE' WHERE event_id = $1 AND row_label = 'A'`, [eventId]);

    const student = students[0];
    const seat1Res = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A' AND seat_number = 1", [eventId]);
    const seat2Res = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A' AND seat_number = 2", [eventId]);
    const seat1Id = seat1Res.rows[0].id;
    const seat2Id = seat2Res.rows[0].id;

    // Hold seat A1
    const firstHold = await holdSeats(student, eventId, [seat1Id]);
    assert.equal(firstHold.success, true);

    // Now hold seat A2 (should replace A1)
    const secondHold = await holdSeats(student, eventId, [seat2Id]);
    assert.equal(secondHold.success, true);

    // Verify previous hold for A1 was marked RELEASED
    const prevHold = await db.query("SELECT status FROM holds WHERE id = $1", [firstHold.hold.id]);
    assert.equal(prevHold.rows[0].status, 'RELEASED', 'Previous active hold must be RELEASED');

    // Verify seat A1 is available again
    const seatMap = await getSeatMap(student, eventId);
    const a1 = seatMap.find(s => s.id === seat1Id);
    assert.equal(a1.state, 'AVAILABLE', 'Previous seat A1 must return to AVAILABLE');
  });

  await t.test('4. Confirm Hold: Converts active hold to confirmed booking', async () => {
    const student = students[2];
    const seatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A' AND seat_number = 4", [eventId]);
    const seatId = seatRes.rows[0].id;

    const holdResult = await holdSeats(student, eventId, [seatId]);
    const confirmResult = await confirmHold(student, holdResult.hold.id);

    assert.equal(confirmResult.success, true);
    assert.equal(confirmResult.booking.status, 'CONFIRMED');

    // Verify seat status on map is now BOOKED
    const seatMap = await getSeatMap(student, eventId);
    const seat = seatMap.find(s => s.id === seatId);
    assert.equal(seat.state, 'BOOKED');
  });

  await t.test('5. Cancel Booking: Releases booked seat back to general inventory', async () => {
    const student = students[3];
    const seatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A' AND seat_number = 5", [eventId]);
    const seatId = seatRes.rows[0].id;

    const holdResult = await holdSeats(student, eventId, [seatId]);
    const confirmResult = await confirmHold(student, holdResult.hold.id);

    // Cancel booking
    const cancelResult = await cancelBooking(student, confirmResult.booking.id);
    assert.equal(cancelResult.success, true);
    assert.equal(cancelResult.booking.status, 'CANCELLED');

    // Seat map must show seat AVAILABLE again
    const seatMap = await getSeatMap(student, eventId);
    const seat = seatMap.find(s => s.id === seatId);
    assert.equal(seat.state, 'AVAILABLE', 'Cancelled seat must be AVAILABLE again');
  });

  await t.test('6. Database Safety Net: Partial Unique Index prevents double booking', async () => {
    // Attempt raw SQL insert of duplicate confirmed booking for same seat
    const seatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A' AND seat_number = 4", [eventId]);
    const seatId = seatRes.rows[0].id;

    // Create a dummy booking record
    const dummyBooking = await db.query(
      `INSERT INTO bookings (event_id, student_id, status) VALUES ($1, $2, 'CONFIRMED') RETURNING id`,
      [eventId, students[4].id]
    );

    // Attempt to insert duplicate confirmed booking_seat for seat A4 (which was confirmed in test 4)
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO booking_seats (booking_id, seat_id, status) VALUES ($1, $2, 'CONFIRMED')`,
          [dummyBooking.rows[0].id, seatId]
        );
      },
      (err) => {
        assert.equal(err.code, '23505', 'PostgreSQL must throw 23505 unique_violation via partial unique index');
        return true;
      },
      'Partial unique index uq_active_booking_seat must reject duplicate confirmed seat'
    );
  });

  await t.test('7. Optimistic Locking on Event Updates: Conflict returns 409', async () => {
    const currentEvent = await getEventById(organizerUser, eventId);
    const initialVersion = currentEvent.version;

    // First update succeeds
    const updated1 = await updateEvent(organizerUser, eventId, {
      title: 'Battle of the Bands - Rock Night 2026 (Updated)',
      version: initialVersion,
    });
    assert.equal(updated1.version, initialVersion + 1, 'Version must increment on update');

    // Stale update with initialVersion must be rejected with 409
    await assert.rejects(
      async () => {
        await updateEvent(organizerUser, eventId, {
          title: 'Battle of the Bands (Stale Update Attempt)',
          version: initialVersion, // Stale version!
        });
      },
      (err) => {
        assert.equal(err.statusCode, 409, 'Stale optimistic lock update must return HTTP 409');
        assert.match(err.message, /Conflict/);
        return true;
      }
    );
  });

  await t.test('8. Organizer Seat Blocking: Cannot block already booked seats', async () => {
    // Seat A4 was confirmed as BOOKED in test 4
    const bookedSeatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'A' AND seat_number = 4", [eventId]);
    const bookedSeatId = bookedSeatRes.rows[0].id;

    await assert.rejects(
      async () => {
        await toggleSeatBlock(organizerUser, bookedSeatId);
      },
      (err) => {
        assert.equal(err.statusCode, 409, 'Must return 409 when attempting to block a booked seat');
        assert.match(err.message, /Cannot block an already booked seat/i);
        return true;
      }
    );

    // But organizer CAN block an available seat (e.g. B10)
    const availableSeatRes = await db.query("SELECT id FROM seats WHERE event_id = $1 AND row_label = 'B' AND seat_number = 10", [eventId]);
    const availableSeatId = availableSeatRes.rows[0].id;

    const blockResult = await toggleSeatBlock(organizerUser, availableSeatId);
    assert.equal(blockResult.action, 'BLOCKED');
    assert.equal(blockResult.seat.status, 'BLOCKED');

    // Unblock it
    const unblockResult = await toggleSeatBlock(organizerUser, availableSeatId);
    assert.equal(unblockResult.action, 'UNBLOCKED');
    assert.equal(unblockResult.seat.status, 'AVAILABLE');
  });
});
