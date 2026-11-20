// src/db/shardRouter.js

const SHARDS = 4;

/**
 * Deterministic 32-bit FNV-1a hash function.
 * Stable across Node.js processes, architectures, and restarts.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Returns the audit shard (0..3) for a given eventId or actorId.
 * When eventId is present, the action is routed by eventId (shard pruning).
 * For non-event actions (like LOGIN, LOGIN_FAILED), actorId is hashed.
 */
const shardFor = (eventId, actorId) => {
  const key = eventId ?? actorId;
  if (!key) {
    return 0;
  }
  return fnv1a(String(key)) % SHARDS;
};

module.exports = { shardFor, SHARDS, fnv1a };
