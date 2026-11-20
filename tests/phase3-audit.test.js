const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { getAuditShard, stableHash } = require('../src/utils/sharding');
const {
  writeAudit,
  listAuditLogs,
  encodeCursor,
  decodeCursor,
} = require('../src/services/audit.service');

test('Phase 3: Audit Sharding, Transactional Logs, and Cursor Pagination Tests', async (t) => {
  t.after(async () => {
    await db.pool.end();
  });

  const adminRes = await db.query("SELECT id, name, email, role FROM users WHERE role = 'ADMIN' LIMIT 1");
  const adminUser = adminRes.rows[0];

  const studentRes = await db.query("SELECT id, name, email, role FROM users WHERE role = 'STUDENT' LIMIT 1");
  const studentUser = studentRes.rows[0];

  await t.test('1. Shard Router Unit Tests: Event actions vs Actor non-event actions', () => {
    // Event action with eventId = 1
    const shard1 = getAuditShard(1, null);
    assert.equal(shard1, stableHash(1) % 4, 'Event 1 must route to stableHash(1) mod 4');

    // Event action with eventId = 2
    const shard2 = getAuditShard(2, null);
    assert.equal(shard2, stableHash(2) % 4, 'Event 2 must route to stableHash(2) mod 4');

    // Non-event action (e.g. LOGIN) with eventId = null, actorId = 4
    const loginShard = getAuditShard(null, 4);
    assert.equal(loginShard, stableHash(4) % 4, 'Non-event actions must route by actorId');

    // Key prioritization: If both eventId and actorId provided, eventId takes precedence
    const combinedShard = getAuditShard(1, 4);
    assert.equal(combinedShard, shard1, 'eventId must take precedence over actorId for sharding');
  });

  await t.test('2. Transactional writeAudit: writeAudit(client, ...) executes inside active transaction', async () => {
    const testAction = 'TEST_TRANSACTIONAL_ACTION_' + Date.now();
    const eventId = 1;
    const targetShard = getAuditShard(eventId, studentUser.id);

    // Write inside an explicit transaction with client
    await db.withTransaction(async (client) => {
      const auditRec = await writeAudit(client, {
        action: testAction,
        actorId: studentUser.id,
        actorRole: 'STUDENT',
        eventId,
        details: { mode: 'transactional_test' },
      });

      assert.equal(auditRec.shard, targetShard);
      assert.equal(auditRec.action, testAction);

      // Verify row exists INSIDE transaction on the target shard
      const checkInside = await client.query(
        `SELECT * FROM audit_logs_${targetShard} WHERE id = $1`,
        [auditRec.id]
      );
      assert.equal(checkInside.rows.length, 1, 'Row must exist within transaction client');
    });

    // Verify row persisted AFTER commit
    const checkAfter = await db.query(
      `SELECT * FROM audit_logs_${targetShard} WHERE action = $1`,
      [testAction]
    );
    assert.equal(checkAfter.rows.length, 1, 'Row must be committed in target shard table');
  });

  await t.test('3. Cursor Encoding/Decoding Unit Tests', () => {
    const nowIso = new Date().toISOString();
    const testId = '12345678-1234-1234-1234-123456789abc';

    const token = encodeCursor(nowIso, testId);
    assert.ok(typeof token === 'string' && token.length > 0);

    const decoded = decodeCursor(token);
    assert.equal(decoded.created_at, nowIso);
    assert.equal(decoded.id, testId);

    // Invalid cursor returns null safely
    assert.equal(decodeCursor('invalid-base64-!'), null);
    assert.equal(decodeCursor(null), null);
  });

  await t.test('4. Cursor Pagination & Scatter-Gather: Merges across 4 shards in strict descending order', async () => {
    const baseTime = Date.now();

    // Insert 60 audit records distributed across all 4 shards
    for (let i = 0; i < 60; i++) {
      // Use existing valid event IDs (1, 2, 3)
      const validEventId = (i % 3) + 1;
      await writeAudit(null, {
        action: 'CURSOR_PAGINATION_TEST',
        actorId: adminUser.id,
        actorRole: 'ADMIN',
        eventId: validEventId,
        details: { seq: i },
      });
    }

    // Query Page 1 with limit = 25
    const page1 = await listAuditLogs(adminUser, { limit: 25 });
    assert.equal(page1.logs.length, 25, 'Page 1 must return exactly 25 records');
    assert.ok(page1.nextCursor, 'Page 1 must return nextCursor token');

    // Query Page 2 using cursor from Page 1
    const page2 = await listAuditLogs(adminUser, { cursor: page1.nextCursor, limit: 25 });
    assert.equal(page2.logs.length, 25, 'Page 2 must return exactly 25 records');
    assert.ok(page2.nextCursor, 'Page 2 must return nextCursor token');

    // Query Page 3 using cursor from Page 2
    const page3 = await listAuditLogs(adminUser, { cursor: page2.nextCursor, limit: 25 });
    assert.ok(page3.logs.length > 0, 'Page 3 must return remaining records');

    // Verify Page 1 and Page 2 have ZERO overlap (no duplicate IDs)
    const page1Ids = new Set(page1.logs.map(l => l.id));
    for (const log of page2.logs) {
      assert.ok(!page1Ids.has(log.id), 'Page 2 record must not duplicate Page 1 record');
    }

    // Verify strict descending chronological order across merged results
    for (let i = 0; i < page1.logs.length - 1; i++) {
      const currTime = new Date(page1.logs[i].created_at).getTime();
      const nextTime = new Date(page1.logs[i + 1].created_at).getTime();
      assert.ok(currTime >= nextTime, 'Merged scatter-gather records must be strictly ordered descending');
    }
  });

  await t.test('5. Date Range Filtering: Constrains records within fromDate and toDate', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString().split('T')[0]; // Yesterday
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString().split('T')[0]; // Tomorrow

    const result = await listAuditLogs(adminUser, {
      dateFrom: pastDate,
      dateTo: futureDate,
      limit: 10,
    });

    assert.ok(Array.isArray(result.logs));
    for (const log of result.logs) {
      const logTime = new Date(log.created_at);
      assert.ok(logTime >= new Date(pastDate), 'Log must be on or after dateFrom');
    }
  });

  await t.test('6. ACCEPTANCE REQUIREMENT: SQL Executed Comparison (1 Shard vs 4 Shards)', async () => {
    // 6A. Event-Filtered Query: Must target EXACTLY 1 Shard (Shard Pruning)
    const filteredResult = await listAuditLogs(adminUser, { eventId: 1, limit: 10 });

    console.log('\n================================================================');
    console.log('[ACCEPTANCE 6A] EVENT-FILTERED QUERY (PRUNED TO EXACTLY 1 SHARD):');
    console.log(`Target Shard: ${filteredResult.shardQueried}`);
    console.log(`Number of SQL queries executed: ${filteredResult.executedSql.length}`);
    filteredResult.executedSql.forEach((sql, idx) => {
      console.log(`Query ${idx + 1}:\n${sql}\n`);
    });

    assert.equal(filteredResult.executedSql.length, 1, 'Event-filtered query MUST execute exactly 1 SQL query');
    const targetShardIndex = getAuditShard(1, null);
    assert.match(filteredResult.shardQueried, new RegExp(`audit_logs_${targetShardIndex}`));
    assert.match(filteredResult.executedSql[0], new RegExp(`FROM audit_logs_${targetShardIndex}`));

    // 6B. Unfiltered Query: Must scatter-gather across ALL 4 SHARDS
    const unfilteredResult = await listAuditLogs(adminUser, { limit: 10 });

    console.log('================================================================');
    console.log('[ACCEPTANCE 6B] UNFILTERED QUERY (SCATTER-GATHER ACROSS 4 SHARDS):');
    console.log(`Target Shards: ${unfilteredResult.shardQueried}`);
    console.log(`Number of SQL queries executed: ${unfilteredResult.executedSql.length}`);
    unfilteredResult.executedSql.forEach((sql, idx) => {
      console.log(`Query ${idx + 1}:\n${sql}\n`);
    });
    console.log('================================================================\n');

    assert.equal(unfilteredResult.executedSql.length, 4, 'Unfiltered query MUST execute exactly 4 SQL queries in parallel');
    assert.match(unfilteredResult.executedSql[0], /audit_logs_0/);
    assert.match(unfilteredResult.executedSql[1], /audit_logs_1/);
    assert.match(unfilteredResult.executedSql[2], /audit_logs_2/);
    assert.match(unfilteredResult.executedSql[3], /audit_logs_3/);
  });
});
