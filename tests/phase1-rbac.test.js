const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { getAuditShard } = require('../src/utils/sharding');
const { listAuditLogs } = require('../src/services/audit.service');
const { listEvents, updateEvent } = require('../src/services/event.service');

test('Phase 1: RBAC, Session, CSRF, and Audit Logging Acceptance Tests', async (t) => {
  t.after(async () => {
    await db.pool.end();
  });

  let studentCookie = null;
  let adminCookie = null;
  let studentUser = null;
  let adminUser = null;

  // Retrieve user IDs for verification
  const studentRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'student@collegefest.edu'");
  studentUser = studentRes.rows[0];

  const adminRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'admin@collegefest.edu'");
  adminUser = adminRes.rows[0];

  await t.test('1. Authentication Flow: Failed login writes LOGIN_FAILED audit row', async () => {
    // First get CSRF token from login page
    const getRes = await request(app).get('/login');
    const csrfMatch = getRes.text.match(/name="_csrf" value="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    const cookie = getRes.headers['set-cookie'];

    const loginRes = await request(app)
      .post('/login')
      .set('Cookie', cookie)
      .send({
        _csrf: csrfToken,
        email: 'student@collegefest.edu',
        password: 'WrongPassword!',
      });

    assert.equal(loginRes.status, 401, 'Should return 401 on incorrect password');

    // Verify LOGIN_FAILED audit log exists in student's shard
    const shard = getAuditShard(null, studentUser.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard} WHERE action = 'LOGIN_FAILED' AND actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [studentUser.id]
    );
    assert.ok(auditRes.rows.length > 0, 'Must record LOGIN_FAILED in audit log');
  });

  await t.test('2. Authentication Flow: Successful student login writes LOGIN audit row and sets secure session cookie', async () => {
    const getRes = await request(app).get('/login');
    const csrfMatch = getRes.text.match(/name="_csrf" value="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    const initialCookie = getRes.headers['set-cookie'];

    const loginRes = await request(app)
      .post('/login')
      .set('Cookie', initialCookie)
      .send({
        _csrf: csrfToken,
        email: 'student@collegefest.edu',
        password: 'Password123!',
      });

    assert.equal(loginRes.status, 302, 'Should redirect after login');
    assert.equal(loginRes.headers.location, '/events');
    studentCookie = loginRes.headers['set-cookie'];
    assert.ok(studentCookie, 'Session cookie must be set');

    // Verify session cookie flags: HttpOnly
    const cookieStr = studentCookie.join(';');
    assert.match(cookieStr, /HttpOnly/i, 'Session cookie must have HttpOnly flag');
    assert.match(cookieStr, /SameSite=Lax/i, 'Session cookie must have SameSite=Lax');

    // Verify LOGIN audit row
    const shard = getAuditShard(null, studentUser.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard} WHERE action = 'LOGIN' AND actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [studentUser.id]
    );
    assert.ok(auditRes.rows.length > 0, 'Must record LOGIN in audit log');
  });

  await t.test('3. CSRF Protection: Mutation request without CSRF token is rejected with 403', async () => {
    const res = await request(app)
      .post('/logout')
      .set('Cookie', studentCookie)
      .send({}); // Missing _csrf

    assert.equal(res.status, 403, 'Must return 403 when CSRF token is missing');
    assert.match(res.text, /CSRF Validation Failed|Invalid or missing CSRF token/i);
  });

  await t.test('4. Role-aware Event Filtering: Student sees only published events', async () => {
    const events = await listEvents(studentUser);
    for (const ev of events) {
      assert.equal(ev.is_published, true, 'Student must not see unpublished/draft events');
    }
  });

  await t.test('5. Role-aware Event Filtering: Admin sees all events including unpublished', async () => {
    const events = await listEvents(adminUser);
    const hasDraft = events.some(e => e.is_published === false);
    assert.ok(hasDraft, 'Admin must see unpublished draft events');
  });

  await t.test('6. ACCEPTANCE REQUIREMENT: Student visiting admin URL gets 403 and ACCESS_DENIED audit row', async () => {
    // Student attempts to access /admin/audit-logs
    const res = await request(app)
      .get('/admin/audit-logs')
      .set('Cookie', studentCookie);

    assert.equal(res.status, 403, 'Acceptance: Student visiting admin URL must receive HTTP 403');
    assert.match(res.text, /403/);
    assert.match(res.text, /Access Denied/i);
    assert.match(res.text, /ACCESS_DENIED/);

    // Verify ACCESS_DENIED audit record was written to the database
    const shard = getAuditShard(null, studentUser.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard}
       WHERE action = 'ACCESS_DENIED' AND actor_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [studentUser.id]
    );

    assert.ok(auditRes.rows.length > 0, 'Acceptance: ACCESS_DENIED audit row must exist in database');
    const record = auditRes.rows[0];
    assert.equal(record.actor_id, studentUser.id);
    assert.equal(record.actor_role, 'STUDENT');
    assert.equal(record.action, 'ACCESS_DENIED');
    assert.equal(record.details.url, '/admin/audit-logs');
    console.log('\n[ACCEPTANCE VERIFIED] Audit record in shard audit_logs_' + shard + ':', {
      id: record.id,
      action: record.action,
      actor_id: record.actor_id,
      actor_role: record.actor_role,
      url: record.details.url,
      reason: record.details.reason,
      created_at: record.created_at,
    });
  });

  await t.test('7. Service-layer Double Protection: Calling listAuditLogs directly as student throws 403', async () => {
    await assert.rejects(
      async () => {
        await listAuditLogs(studentUser, {});
      },
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /Access denied/);
        return true;
      },
      'Service must reject unauthorized call even if middleware were somehow bypassed'
    );
  });
});
