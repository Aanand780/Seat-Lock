const test = require('node:test');
const assert = require('node:assert/strict');
const { stableHash, getAuditShard } = require('../src/utils/sharding');

test('Audit Sharding Unit Tests', async (t) => {
  await t.test('stableHash should produce deterministic results across multiple runs', () => {
    const val1 = stableHash(42);
    const val2 = stableHash(42);
    const val3 = stableHash('42');
    assert.equal(val1, val2, 'Hash must be identical for same input');
    assert.equal(val1, val3, 'Hash must be identical for number and string representation');
  });

  await t.test('getAuditShard should always return 0, 1, 2, or 3', () => {
    const testKeys = [0, 1, 2, 3, 4, 10, 100, 999, 'event-uuid-1', 'actor-123', null];
    for (const key of testKeys) {
      const shard = getAuditShard(key, null);
      assert.ok(shard >= 0 && shard <= 3, `Shard ${shard} must be in range 0..3 for key ${key}`);
    }
  });

  await t.test('getAuditShard should prioritize event_id over actor_id', () => {
    const eventId = 15;
    const actorId = 99;
    const shardWithBoth = getAuditShard(eventId, actorId);
    const shardWithOnlyEvent = getAuditShard(eventId, null);
    assert.equal(shardWithBoth, shardWithOnlyEvent, 'Must route by event_id when event_id is present');
  });

  await t.test('getAuditShard should fall back to actor_id when event_id is null', () => {
    const actorId = 42;
    const shard = getAuditShard(null, actorId);
    const expected = stableHash(actorId) % 4;
    assert.equal(shard, expected, 'Must route by actor_id when event_id is null');
  });
});
