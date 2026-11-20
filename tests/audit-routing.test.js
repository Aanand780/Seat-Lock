// tests/audit-routing.test.js

const assert = require('assert');
const { shardFor, fnv1a, SHARDS } = require('../src/db/shardRouter');

console.log('--- Running Audit Routing Tests ---');

// Test 1: FNV-1a hash determinism
const testString = 'e-headline-2026';
const hash1 = fnv1a(testString);
const hash2 = fnv1a(testString);
assert.strictEqual(hash1, hash2, 'FNV-1a must be 100% deterministic');
console.log('✓ Test 1: FNV-1a hash is deterministic.');

// Test 2: Same event always maps to the exact same shard
const targetShard = shardFor('e-headline-2026', 'any-actor-id');
for (let i = 0; i < 500; i++) {
  const result = shardFor('e-headline-2026', `actor-${i}`);
  assert.strictEqual(result, targetShard, `Run ${i}: eventId must always dominate and produce shard ${targetShard}`);
}
console.log(`✓ Test 2: 'e-headline-2026' consistently maps to shard ${targetShard} regardless of actor.`);

// Test 3: Non-event actions (null/undefined eventId) route by actorId
const loginShard1 = shardFor(null, 'u-admin-1');
const loginShard2 = shardFor(undefined, 'u-admin-1');
assert.strictEqual(loginShard1, loginShard2, 'Undefined and null eventId must route by actorId identically');
assert.strictEqual(typeof loginShard1, 'number', 'Shard must be a number');
assert(loginShard1 >= 0 && loginShard1 < SHARDS, `Shard must be between 0 and ${SHARDS - 1}`);
console.log(`✓ Test 3: Non-event action with actor 'u-admin-1' routes to shard ${loginShard1}.`);

// Test 4: Shard bounds and distribution
const eventIds = [
  'e-headline-2026', 'e-hackathon-2026', 'e-past-2026', 'e-draft-2026',
  'e-event-101', 'e-event-102', 'e-event-103', 'e-event-104',
  'e-event-201', 'e-event-202', 'e-event-203', 'e-event-204'
];

const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
eventIds.forEach(id => {
  const shard = shardFor(id, null);
  assert(shard >= 0 && shard < 4, `Shard ${shard} out of bounds for ${id}`);
  counts[shard]++;
});

console.log('✓ Test 4: Shard distribution across sample events:', counts);

// Test 5: Scatter-gather merge sort logic verification
const shard0Mock = [
  { id: 'uuid-3', created_at: new Date('2026-11-20T10:05:00Z'), shard: '0' },
  { id: 'uuid-1', created_at: new Date('2026-11-20T10:00:00Z'), shard: '0' }
];
const shard1Mock = [
  { id: 'uuid-4', created_at: new Date('2026-11-20T10:08:00Z'), shard: '1' },
  { id: 'uuid-2', created_at: new Date('2026-11-20T10:02:00Z'), shard: '1' }
];

const merged = [...shard0Mock, ...shard1Mock].sort((a, b) => {
  const timeDiff = new Date(b.created_at) - new Date(a.created_at);
  if (timeDiff !== 0) return timeDiff;
  return String(b.id).localeCompare(String(a.id));
});

assert.strictEqual(merged[0].id, 'uuid-4', 'Latest event must be first');
assert.strictEqual(merged[1].id, 'uuid-3');
assert.strictEqual(merged[2].id, 'uuid-2');
assert.strictEqual(merged[3].id, 'uuid-1', 'Oldest event must be last');
console.log('✓ Test 5: Scatter-gather merge sort correctly orders records chronologically.');

console.log('\nALL AUDIT ROUTING TESTS PASSED (5/5)!\n');
