/**
 * High-Concurrency Automated Load-Test Script for SeatLock
 * Simulates extreme peak burst traffic (50 concurrent students contending for seats)
 *
 * Asserts:
 * - Total requests
 * - Successes (HTTP 200)
 * - Conflicts (HTTP 409)
 * - Lock Timeouts (HTTP 503)
 * - PASS/FAIL: Exactly ONE winner per seat under ACID row-level locking
 */

require('dotenv').config();
const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('../src/config/db');
const app = require('../src/app');

const CONCURRENT_WORKERS = 50;
const PORT = process.env.PORT || 3001;

async function checkServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/events`, (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function runLoadTest() {
  console.log('================================================================');
  console.log('       SEATLOCK HIGH-CONCURRENCY STRESS & LOAD TEST             ');
  console.log('================================================================');
  console.log(`Target concurrency level: ${CONCURRENT_WORKERS} simultaneous requests`);

  // 1. Ensure server is running
  let serverInstance = null;
  let baseUrl = `http://localhost:${PORT}`;

  const alreadyRunning = await checkServerRunning(PORT);
  if (!alreadyRunning) {
    serverInstance = app.listen(PORT);
    console.log(`Ephemeral test server started on ${baseUrl}`);
  } else {
    console.log(`Connecting to existing server at ${baseUrl}`);
  }

  try {
    // 2. Setup contestable event & seat
    const eventRes = await db.query(
      "SELECT id, title FROM events WHERE is_published = true ORDER BY id ASC LIMIT 1"
    );
    const event = eventRes.rows[0];
    assertCondition(event, 'Published event must exist in database');

    const seatRes = await db.query(
      `SELECT id, row_label, seat_number FROM seats
       WHERE event_id = $1 AND row_label = 'B' AND seat_number = 1`,
      [event.id]
    );
    const targetSeat = seatRes.rows[0];
    assertCondition(targetSeat, 'Target seat B1 must exist');

    console.log(`Contested Seat: ${targetSeat.row_label}${targetSeat.seat_number} (Seat ID: ${targetSeat.id})`);
    console.log(`Target Event: #${event.id} - "${event.title}"`);

    // Reset target seat state before test
    await db.query('DELETE FROM booking_seats WHERE seat_id = $1', [targetSeat.id]);
    await db.query('DELETE FROM hold_seats WHERE seat_id = $1', [targetSeat.id]);
    await db.query("UPDATE seats SET status = 'AVAILABLE' WHERE id = $1", [targetSeat.id]);

    // 3. Create N distinct students with authenticated sessions
    console.log(`\nPreparing ${CONCURRENT_WORKERS} distinct student sessions...`);
    const passwordHash = await bcrypt.hash('Password123!', 6);
    const studentSessions = [];

    for (let i = 1; i <= CONCURRENT_WORKERS; i++) {
      const email = `loadtest_student_${i}_${Date.now()}@collegefest.edu`;
      const userRes = await db.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'STUDENT')
         RETURNING id, name, email, role`,
        [`Load Tester ${i}`, email, passwordHash]
      );
      const student = userRes.rows[0];

      // Perform HTTP login to obtain authenticated session cookie + post-login CSRF token
      const sessionData = await loginStudent(baseUrl, event.id, student.email, 'Password123!');
      studentSessions.push({ student, ...sessionData });
    }
    console.log(`All ${CONCURRENT_WORKERS} student sessions established.`);

    // 4. Launch simultaneous hold requests
    console.log(`\n>>> FIRING ${CONCURRENT_WORKERS} SIMULTANEOUS SEAT-HOLD REQUESTS <<<`);
    const startTime = Date.now();

    const requestPromises = studentSessions.map((sess) =>
      sendHoldRequest(baseUrl, event.id, targetSeat.id, sess.cookie, sess.csrfToken)
    );

    const responses = await Promise.all(requestPromises);
    const durationMs = Date.now() - startTime;

    // 5. Aggregate metrics
    let successes = 0;
    let conflicts409 = 0;
    let timeouts503 = 0;
    let otherErrors = 0;
    let winningStudent = null;

    responses.forEach((resp, idx) => {
      if (resp.status === 200 || resp.status === 302) {
        successes++;
        winningStudent = studentSessions[idx].student;
      } else if (resp.status === 409) {
        conflicts409++;
      } else if (resp.status === 503) {
        timeouts503++;
      } else {
        otherErrors++;
        console.error(`Unexpected response status ${resp.status}:`, resp.body);
      }
    });

    // 6. Verify Database State
    const activeHolds = await db.query(
      `SELECT h.id, h.student_id, u.name as winner_name, u.email as winner_email
       FROM hold_seats hs
       JOIN holds h ON hs.hold_id = h.id
       JOIN users u ON h.student_id = u.id
       WHERE hs.seat_id = $1 AND h.status = 'ACTIVE'`,
      [targetSeat.id]
    );

    console.log('\n================================================================');
    console.log('                    LOAD-TEST RESULTS SUMMARY                   ');
    console.log('================================================================');
    console.log(`Duration:              ${durationMs} ms`);
    console.log(`Total Requests:        ${CONCURRENT_WORKERS}`);
    console.log(`Successes (200/302):   ${successes}`);
    console.log(`Conflicts (409):       ${conflicts409}`);
    console.log(`Lock Timeouts (503):   ${timeouts503}`);
    console.log(`Other Statuses:        ${otherErrors}`);
    console.log('----------------------------------------------------------------');
    console.log(`Active Holds in DB:    ${activeHolds.rows.length}`);
    if (activeHolds.rows.length > 0) {
      console.log(`Winner in Database:    ${activeHolds.rows[0].winner_name} (${activeHolds.rows[0].winner_email})`);
    }
    console.log('================================================================');

    // 7. Strict Assertion: EXACTLY ONE WINNER PER SEAT
    const isSingleWinner = (successes === 1) && (activeHolds.rows.length === 1);
    const noAnomalies = (conflicts409 + timeouts503 === CONCURRENT_WORKERS - 1) && (otherErrors === 0);

    if (isSingleWinner && noAnomalies) {
      console.log('>>> TEST RESULT: [PASS] - EXACTLY ONE WINNER PER SEAT GUARANTEED <<<');
      console.log('Pessimistic row-level locking (SELECT ... FOR UPDATE) and lock_timeout prevented all race conditions.');
    } else {
      console.error('>>> TEST RESULT: [FAIL] - CONCURRENCY VIOLATION DETECTED <<<');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Fatal load-test error:', err);
    process.exitCode = 1;
  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
    await db.pool.end();
  }
}

function assertCondition(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Helper: HTTP login and obtain authenticated session cookie & post-login CSRF token
function loginStudent(baseUrl, eventId, email, password) {
  return new Promise((resolve, reject) => {
    // 1. GET /login to extract pre-login CSRF token and cookie
    http.get(`${baseUrl}/login`, (res) => {
      let cookie = res.headers['set-cookie'] ? res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') : '';
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const csrfMatch = data.match(/name="_csrf" value="([^"]+)"/);
        const preLoginCsrf = csrfMatch ? csrfMatch[1] : '';

        // 2. POST /login
        const postData = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(preLoginCsrf)}`;
        const postReq = http.request(`${baseUrl}/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'Cookie': cookie,
          },
        }, (loginRes) => {
          if (loginRes.headers['set-cookie']) {
            cookie = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
          }
          loginRes.resume();

          // 3. GET /events/:id/seats with authenticated cookie to get the new session CSRF token
          http.get(`${baseUrl}/events/${eventId}/seats`, {
            headers: { 'Cookie': cookie }
          }, (seatPageRes) => {
            let seatPageHtml = '';
            seatPageRes.on('data', chunk => seatPageHtml += chunk);
            seatPageRes.on('end', () => {
              const postLoginCsrfMatch = seatPageHtml.match(/name="_csrf" value="([^"]+)"/);
              const authCsrfToken = postLoginCsrfMatch ? postLoginCsrfMatch[1] : preLoginCsrf;
              resolve({ cookie, csrfToken: authCsrfToken });
            });
          }).on('error', reject);
        });

        postReq.on('error', reject);
        postReq.write(postData);
        postReq.end();
      });
    }).on('error', reject);
  });
}

// Helper: Send hold request
function sendHoldRequest(baseUrl, eventId, seatId, cookie, csrfToken) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ seatIds: [seatId], _csrf: csrfToken });
    const req = http.request(`${baseUrl}/events/${eventId}/hold`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
        'Cookie': cookie,
        'x-csrf-token': csrfToken,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', (err) => {
      resolve({ status: 500, body: err.message });
    });

    req.write(payload);
    req.end();
  });
}

runLoadTest();
