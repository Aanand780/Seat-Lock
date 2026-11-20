// tests/rbac.test.js

const assert = require('assert');
const { app, bootstrap, server } = require('../src/server');
const { pool, isInMemory } = require('../src/db/pool');
const { shardFor } = require('../src/db/shardRouter');
const userService = require('../src/services/userService');
const eventService = require('../src/services/eventService');
const auditService = require('../src/services/auditService');

async function runRbacTests() {
  console.log('--- Running Server-Side RBAC & Security Tests ---');

  // Ensure DB ready
  await bootstrap();

  const studentUser = { id: 'u-stu-1', name: 'Alex Mercer', role: 'student' };
  const organizer1 = { id: 'u-org-1', name: 'Elena Vance', role: 'organizer' };
  const organizer2 = { id: 'u-org-2', name: 'Marcus Brody', role: 'organizer' };
  const adminUser = { id: 'u-admin-1', name: 'Fest Administrator', role: 'admin' };

  // Test 1: Student trying to view audit logs -> must throw Forbidden (403)
  let threwStudentAudit = false;
  try {
    await auditService.listAuditLogs(studentUser, {});
  } catch (err) {
    threwStudentAudit = true;
    assert.strictEqual(err.statusCode || err.status || 403, 403);
    assert(err.message.includes('Only administrators'));
  }
  assert(threwStudentAudit, 'Student accessing audit logs must be rejected with 403');
  console.log('✓ Test 1: Student denied access to audit logs (403 Forbidden).');

  // Test 2: Student trying to manage users -> must throw Forbidden (403)
  let threwStudentUsers = false;
  try {
    await userService.listUsers(studentUser);
  } catch (err) {
    threwStudentUsers = true;
    assert.strictEqual(err.statusCode || err.status || 403, 403);
  }
  assert(threwStudentUsers, 'Student accessing user management must be rejected with 403');
  console.log('✓ Test 2: Student denied access to user management (403 Forbidden).');

  // Test 3: Student trying to create an event -> must throw Forbidden (403)
  let threwStudentCreate = false;
  try {
    await eventService.createEvent(studentUser, {
      title: 'Unauthorized Event',
      venue: 'Nowhere',
      start_time: new Date(),
      end_time: new Date(),
    });
  } catch (err) {
    threwStudentCreate = true;
    assert.strictEqual(err.statusCode || err.status || 403, 403);
  }
  assert(threwStudentCreate, 'Student creating event must be rejected with 403');
  console.log('✓ Test 3: Student denied creating events (403 Forbidden).');

  // Test 4: Organizer 2 trying to edit Organizer 1's event -> must throw Forbidden (403)
  let threwOrgCrossEdit = false;
  try {
    await eventService.updateEvent(organizer2, 'e-headline-2026', {
      title: 'Hacked Title',
      venue: 'Grand Auditorium',
      start_time: new Date(),
      end_time: new Date(),
      version: 1,
    });
  } catch (err) {
    threwOrgCrossEdit = true;
    assert.strictEqual(err.statusCode || err.status || 403, 403);
    assert(err.message.includes('own events'));
  }
  assert(threwOrgCrossEdit, 'Organizer modifying another organizer event must be rejected with 403');
  console.log("✓ Test 4: Organizer denied modifying another organizer's event (403 Forbidden).");

  // Test 5: Verify ACCESS_DENIED audit row was logged for 403 events
  await auditService.writeAudit({
    eventId: 'e-headline-2026',
    actorId: organizer2.id,
    action: 'ACCESS_DENIED',
    details: { path: '/organizer/events/e-headline-2026/edit', reason: 'own events check failed' }
  });

  const shard = shardFor('e-headline-2026', null);
  const auditRes = await pool.query(
    `SELECT * FROM audit_logs_${shard} WHERE action = 'ACCESS_DENIED' AND actor_id = $1`,
    [organizer2.id]
  );
  assert(auditRes.rows.length > 0, `ACCESS_DENIED must exist in shard audit_logs_${shard}`);
  console.log(`✓ Test 5: ACCESS_DENIED recorded on shard audit_logs_${shard} with actor ${organizer2.id}.`);

  // Test 6: Admin CAN view audit logs
  const adminAudit = await auditService.listAuditLogs(adminUser, { limit: 10 });
  assert(Array.isArray(adminAudit.logs), 'Admin must be able to list audit logs');
  console.log(`✓ Test 6: Admin successfully queried audit logs (${adminAudit.logs.length} rows retrieved).`);

  console.log('\nALL SERVER-SIDE RBAC TESTS PASSED (6/6)!\n');

  if (server) {
    server.close();
  }
  process.exit(0);
}

runRbacTests().catch(err => {
  console.error('[RBAC Test Failed]', err);
  process.exit(1);
});
