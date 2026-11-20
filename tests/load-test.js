// tests/load-test.js

const assert = require('assert');
const { pool } = require('../src/db/pool');
const { initDb } = require('../src/db/pool');
const bookingService = require('../src/services/bookingService');
const { ConflictError } = require('../src/services/eventService');

async function runLoadTest() {
  console.log('\n======================================================');
  console.log('⚡ SEATLOCK CONCURRENCY LOAD TEST: N Concurrent Holds ⚡');
  console.log('======================================================\n');

  // Initialize DB if not already initialized
  await initDb();

  const eventId = 'e-headline-2026';
  const targetSeatId = 's-A01'; // Seat A1
  const targetSeatNumber = 'A1';

  // 1. Clean up any existing holds/bookings for seat A1 to start from a clean slate
  await pool.query('DELETE FROM holds WHERE seat_id = $1', [targetSeatId]);
  await pool.query(
    'DELETE FROM booking_seats WHERE seat_id = $1',
    [targetSeatId]
  );
  console.log(`[Setup] Target seat ${targetSeatNumber} (${targetSeatId}) cleared and ready.`);

  // 2. Prepare N concurrent student actors and ensure they exist in users table
  const N = 12; // 12 concurrent requests
  console.log(`[Load Test] Launching ${N} concurrent hold requests for seat ${targetSeatNumber}...`);

  const students = [];
  for (let i = 1; i <= N; i++) {
    const student = {
      id: `u-load-test-student-${i}`,
      name: `Concurrent Student ${i}`,
      email: `concurrent${i}@loadtest.org`,
      role: 'student',
    };
    students.push(student);

    // Insert student into users table to satisfy foreign key constraint
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, $2, $3, 'dummy-hash', 'student')
       ON CONFLICT (id) DO NOTHING`,
      [student.id, student.name, student.email]
    );
  }

  // 3. Dispatch N simultaneous hold requests using Promise.all
  const startTime = Date.now();
  const results = await Promise.allSettled(
    students.map(student =>
      bookingService.holdSeats(student, {
        eventId,
        seatIds: [targetSeatId],
      })
    )
  );
  const elapsed = Date.now() - startTime;

  // 4. Analyze results
  const winners = [];
  const rejected = [];

  results.forEach((res, index) => {
    const student = students[index];
    if (res.status === 'fulfilled') {
      winners.push({ student: student.id, data: res.value });
    } else {
      const err = res.reason;
      rejected.push({
        student: student.id,
        error: err.message,
        statusCode: err.statusCode || 409,
        unavailableSeats: err.details?.unavailableSeats || [],
      });
    }
  });

  console.log(`\n[Results in ${elapsed}ms]`);
  console.log(`  - Successful holds (Winners): ${winners.length}`);
  console.log(`  - Rejected holds (409 Conflicts): ${rejected.length}`);
  if (rejected.length > 0) {
    console.log('  - Sample rejection reason:', rejected[0].error, 'Code:', rejected[0].statusCode);
  }

  // 5. Assertions: Concurrency Correctness
  assert.strictEqual(
    winners.length,
    1,
    `CRITICAL FAILURE: Expected exactly 1 winner, but got ${winners.length}!`
  );
  assert.strictEqual(
    rejected.length,
    N - 1,
    `CRITICAL FAILURE: Expected ${N - 1} conflicts, but got ${rejected.length}!`
  );

  console.log(`\n✓ Concurrency guarantee validated: Exactly 1 winner (${winners[0].student})`);
  console.log(`✓ All ${N - 1} competing requests rejected with HTTP 409 Conflict.`);

  // Verify that rejected requests correctly identified the unavailable seat
  for (const rej of rejected) {
    assert.strictEqual(rej.statusCode, 409, 'Rejected status code must be 409');
    assert(
      rej.error.includes(targetSeatNumber),
      `Error response must name unavailable seat ${targetSeatNumber}`
    );
  }
  console.log(`✓ All ${rejected.length} conflict responses named seat '${targetSeatNumber}' as unavailable.`);

  // 6. Database Verification: Check database uniqueness constraint and hold table
  const dbHoldsRes = await pool.query(
    'SELECT * FROM holds WHERE seat_id = $1',
    [targetSeatId]
  );
  assert.strictEqual(
    dbHoldsRes.rows.length,
    1,
    `Database holds count must be exactly 1, found ${dbHoldsRes.rows.length}`
  );
  assert.strictEqual(
    dbHoldsRes.rows[0].user_id,
    winners[0].student,
    'Database hold user_id must match the winning student'
  );
  console.log(`✓ Database verification passed: Exactly 1 hold record exists in 'holds' table for seat ${targetSeatId}.`);

  // 7. Multi-Seat All-or-Nothing Concurrency Test
  console.log('\n--- Testing Multi-Seat All-or-Nothing Concurrency ---');
  const seatB1 = 's-B01';
  const seatB2 = 's-B02';
  const seatB3 = 's-B03';

  // Clean up any holds on these seats or by these users
  await pool.query('DELETE FROM holds WHERE seat_id IN ($1, $2, $3)', [seatB1, seatB2, seatB3]);
  await pool.query('DELETE FROM holds WHERE user_id IN ($1, $2)', ['u-stu-multi-A', 'u-stu-multi-B']);

  // Student A requests B1 and B2; Student B simultaneously requests B2 and B3
  const stuA = { id: 'u-stu-multi-A', role: 'student' };
  const stuB = { id: 'u-stu-multi-B', role: 'student' };

  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role)
     VALUES ('u-stu-multi-A', 'Multi Stu A', 'multiA@test.org', 'dummy-hash', 'student'),
            ('u-stu-multi-B', 'Multi Stu B', 'multiB@test.org', 'dummy-hash', 'student')
     ON CONFLICT (id) DO NOTHING`
  );

  const multiResults = await Promise.allSettled([
    bookingService.holdSeats(stuA, { eventId, seatIds: [seatB1, seatB2] }),
    bookingService.holdSeats(stuB, { eventId, seatIds: [seatB2, seatB3] }),
  ]);

  const multiWinners = multiResults.filter(r => r.status === 'fulfilled');
  const multiRejected = multiResults.filter(r => r.status === 'rejected');

  assert.strictEqual(multiWinners.length, 1, 'Only one multi-seat request can succeed when overlapping');
  assert.strictEqual(multiRejected.length, 1, 'The overlapping multi-seat request must be rejected');

  const winnerStudent = multiResults[0].status === 'fulfilled' ? stuA : stuB;
  const rejectedStudent = multiResults[0].status === 'fulfilled' ? stuB : stuA;

  // Verify that the rejected student got none of the seats (All-or-Nothing)
  const rejectedHoldsInDb = await pool.query(
    'SELECT * FROM holds WHERE user_id = $1 AND event_id = $2',
    [rejectedStudent.id, eventId]
  );
  assert.strictEqual(
    rejectedHoldsInDb.rows.length,
    0,
    'Rejected student must have 0 held seats (all-or-nothing principle)'
  );
  console.log(`✓ Multi-seat All-or-Nothing validated: Winner was ${winnerStudent.id}, and loser (${rejectedStudent.id}) was granted 0 seats.`);

  console.log('\n======================================================');
  console.log('🎉 ALL CONCURRENCY LOAD TESTS PASSED FLAWLESSLY! 🎉');
  console.log('======================================================\n');

  process.exit(0);
}

runLoadTest().catch(err => {
  console.error('[Load Test Failed]', err);
  process.exit(1);
});
