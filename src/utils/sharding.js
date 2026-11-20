/**
 * Deterministic hash function for audit log sharding.
 * Implements 32-bit FNV-1a hash algorithm to guarantee reproducible,
 * even distribution across the 4 shards (0, 1, 2, 3).
 *
 * @param {string|number} key - event_id or actor_id
 * @returns {number} positive 32-bit integer
 */
function stableHash(key) {
  if (key === null || key === undefined) {
    return 0;
  }
  const str = String(key);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Math.imul(a, b) performs 32-bit integer multiplication
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0); // Convert to unsigned 32-bit integer
}

/**
 * Determine the audit log shard (0..3) for a given action.
 * Rule: Shard = stable_hash(event_id) mod 4; for non-event actions use actor_id.
 *
 * @param {number|null} eventId
 * @param {number|null} actorId
 * @returns {number} shard index (0, 1, 2, or 3)
 */
function getAuditShard(eventId, actorId) {
  const routingKey = (eventId !== null && eventId !== undefined) ? eventId : actorId;
  const hash = stableHash(routingKey);
  return hash % 4;
}

module.exports = {
  stableHash,
  getAuditShard,
};
