const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { getAdminSalesDashboard } = require('../src/services/dashboard.service');
const { getAuditShard } = require('../src/utils/sharding');

test('Admin Sales & Ticket Inventory Dashboard Tests', async (t) => {
  t.after(async () => {
    await db.pool.end();
  });

  let studentCookie = null;
  let adminCookie = null;
  let studentUser = null;
  let adminUser = null;

  const studentRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'student@collegefest.edu'");
  studentUser = studentRes.rows[0];

  const adminRes = await db.query("SELECT id, name, email, role FROM users WHERE email = 'admin@collegefest.edu'");
  adminUser = adminRes.rows[0];

  // Log in as student to get student cookie
  const studentGetLogin = await request(app).get('/login');
  const studentCsrfMatch = studentGetLogin.text.match(/name="_csrf" value="([^"]+)"/);
  const studentCsrf = studentCsrfMatch ? studentCsrfMatch[1] : '';
  const studentPreCookie = studentGetLogin.headers['set-cookie'];

  const studentLoginRes = await request(app)
    .post('/login')
    .set('Cookie', studentPreCookie)
    .send({
      _csrf: studentCsrf,
      email: 'student@collegefest.edu',
      password: 'Password123!',
    });
  studentCookie = studentLoginRes.headers['set-cookie'];

  // Log in as admin to get admin cookie
  const adminGetLogin = await request(app).get('/login');
  const adminCsrfMatch = adminGetLogin.text.match(/name="_csrf" value="([^"]+)"/);
  const adminCsrf = adminCsrfMatch ? adminCsrfMatch[1] : '';
  const adminPreCookie = adminGetLogin.headers['set-cookie'];

  const adminLoginRes = await request(app)
    .post('/login')
    .set('Cookie', adminPreCookie)
    .send({
      _csrf: adminCsrf,
      email: 'admin@collegefest.edu',
      password: 'Password123!',
    });
  adminCookie = adminLoginRes.headers['set-cookie'];

  await t.test('1. Service Layer RBAC: Non-admin calling getAdminSalesDashboard throws 403', async () => {
    // Unauthenticated call
    await assert.rejects(
      async () => getAdminSalesDashboard(null),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /ADMIN role/i);
        return true;
      }
    );

    // Student call
    await assert.rejects(
      async () => getAdminSalesDashboard(studentUser),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /ADMIN role/i);
        return true;
      }
    );
  });

  await t.test('2. Service Layer: Admin successfully retrieves ticket sales & remaining inventory metrics', async () => {
    const data = await getAdminSalesDashboard(adminUser);

    assert.ok(data.summary, 'Summary metrics object must exist');
    assert.ok(typeof data.summary.totalCapacity === 'number', 'Total capacity must be number');
    assert.ok(typeof data.summary.totalTicketsBooked === 'number', 'Total tickets booked must be number');
    assert.ok(typeof data.summary.totalTicketsRemaining === 'number', 'Total tickets remaining must be number');
    assert.ok(typeof data.summary.totalHeldTickets === 'number', 'Total held tickets must be number');
    assert.ok(typeof data.summary.totalBlockedTickets === 'number', 'Total blocked tickets must be number');

    // Capacity invariant: Capacity = Booked + Remaining + Held + Blocked
    const totalAccounted = data.summary.totalTicketsBooked +
      data.summary.totalTicketsRemaining +
      data.summary.totalHeldTickets +
      data.summary.totalBlockedTickets;
    assert.equal(totalAccounted, data.summary.totalCapacity, 'All seats must strictly balance between Booked, Remaining, Held, and Blocked');

    assert.ok(Array.isArray(data.eventSales), 'eventSales must be an array');
    assert.ok(data.eventSales.length > 0, 'Must return monitored events');

    for (const ev of data.eventSales) {
      assert.ok(ev.title, 'Event must have a title');
      assert.equal(typeof ev.total_seats, 'number');
      assert.equal(typeof ev.booked_seats, 'number');
      assert.equal(typeof ev.remaining_seats, 'number');
      assert.ok(ev.remaining_seats >= 0, 'Remaining seats must never be negative');
      assert.equal(ev.remaining_seats, Math.max(0, ev.total_seats - ev.booked_seats - ev.held_seats - ev.blocked_seats));
    }
  });

  await t.test('3. Route Security: Student accessing /admin/dashboard gets 403 and ACCESS_DENIED audit log', async () => {
    const res = await request(app)
      .get('/admin/dashboard')
      .set('Cookie', studentCookie);

    assert.equal(res.status, 403, 'Must return HTTP 403 for student accessing admin dashboard');
    assert.match(res.text, /Access Denied/i);

    // Verify ACCESS_DENIED in student's audit shard
    const shard = getAuditShard(null, studentUser.id);
    const auditRes = await db.query(
      `SELECT * FROM audit_logs_${shard} WHERE action = 'ACCESS_DENIED' AND actor_id = $1 AND details->>'url' = '/admin/dashboard' ORDER BY created_at DESC LIMIT 1`,
      [studentUser.id]
    );
    assert.ok(auditRes.rows.length > 0, 'Must record ACCESS_DENIED in sharded audit log for unauthorized dashboard visit');
  });

  await t.test('4. Route Integration: Admin accessing /admin/dashboard gets 200 with rendered metrics', async () => {
    const res = await request(app)
      .get('/admin/dashboard')
      .set('Cookie', adminCookie);

    assert.equal(res.status, 200, 'Must return HTTP 200 for admin accessing dashboard');
    assert.match(res.text, /Ticket Sales & Capacity Dashboard/i);
    assert.match(res.text, /Tickets Booked/i);
    assert.match(res.text, /Tickets Remaining/i);
    assert.match(res.text, /Active Holds/i);
    assert.match(res.text, /Admissions Checked In/i);
  });
});
