const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { getAuditShard } = require('../utils/sharding');

/**
 * Write an audit record across the 4 sharded audit tables.
 * Shard = stable_hash(event_id) mod 4; for non-event actions use actor_id.
 *
 * @param {object|null} currentUser - Session user (can be null for public/login actions)
 * @param {object} params
 * @param {number|null} params.actorId
 * @param {string|null} params.actorRole
 * @param {string} params.action - LOGIN, LOGIN_FAILED, SEAT_HOLD, SEAT_HOLD_REJECTED, HOLD_EXPIRED,
 *                                  BOOKING_CONFIRMED, BOOKING_CANCELLED, EVENT_UPDATED, CHECKIN, ACCESS_DENIED
 * @param {number|null} params.eventId
 * @param {object} [params.details={}]
 * @param {object} [params.client=null] - Optional pg client for transactional audit logging
 * @returns {Promise<object>} The inserted audit record
 */
async function writeAudit(currentUser, {
  actorId = null,
  actorRole = null,
  action,
  eventId = null,
  details = {},
  client = null
}) {
  const finalActorId = currentUser ? currentUser.id : actorId;
  const finalActorRole = currentUser ? currentUser.role : actorRole;

  const shardIndex = getAuditShard(eventId, finalActorId);
  const tableName = `audit_logs_${shardIndex}`;
  const id = uuidv4();
  const now = new Date();

  const queryText = `
    INSERT INTO ${tableName} (id, actor_id, actor_role, action, event_id, details, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;
  const params = [
    id,
    finalActorId,
    finalActorRole,
    action,
    eventId,
    JSON.stringify(details || {}),
    now
  ];

  const executor = client || db;
  const result = await executor.query(queryText, params);
  const row = result.rows[0];

  return {
    ...row,
    shard: shardIndex,
  };
}

/**
 * List audit logs with role check, shard pruning, and cursor pagination.
 *
 * @param {object} currentUser - Must have ADMIN role
 * @param {object} options
 * @param {number|null} options.eventId - If provided, targets exact single shard
 * @param {string|null} options.cursorCreatedAt - Cursor for pagination
 * @param {string|null} options.cursorId - Cursor tiebreaker
 * @param {number} [options.limit=50]
 * @returns {Promise<{ logs: Array, nextCursor: object|null, shardQueried: string }>}
 */
async function listAuditLogs(currentUser, {
  eventId = null,
  cursorCreatedAt = null,
  cursorId = null,
  limit = 50
} = {}) {
  // Role check inside service
  if (!currentUser || currentUser.role !== 'ADMIN') {
    const error = new Error('Access denied: listAuditLogs requires ADMIN role');
    error.statusCode = 403;
    throw error;
  }

  // Shard pruning: If eventId is provided, query only that specific shard
  if (eventId !== null && eventId !== undefined && eventId !== '') {
    const parsedEventId = parseInt(eventId, 10);
    const shardIndex = getAuditShard(parsedEventId, null);
    const tableName = `audit_logs_${shardIndex}`;

    let sql = `
      SELECT a.*, u.name as actor_name, u.email as actor_email, e.title as event_title, ${shardIndex} as shard
      FROM ${tableName} a
      LEFT JOIN users u ON a.actor_id = u.id
      LEFT JOIN events e ON a.event_id = e.id
      WHERE a.event_id = $1
    `;
    const params = [parsedEventId];

    if (cursorCreatedAt && cursorId) {
      sql += ` AND (a.created_at, a.id) < ($2, $3)`;
      params.push(cursorCreatedAt, cursorId);
    }

    sql += ` ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const result = await db.query(sql, params);
    const hasMore = result.rows.length > limit;
    const logs = hasMore ? result.rows.slice(0, limit) : result.rows;

    let nextCursor = null;
    if (hasMore && logs.length > 0) {
      const last = logs[logs.length - 1];
      nextCursor = { created_at: last.created_at, id: last.id };
    }

    return {
      logs,
      nextCursor,
      shardQueried: `Shard ${shardIndex} (Pruned by event_id=${parsedEventId})`,
    };
  }

  // Scatter-gather: Unfiltered query reads all four shards, merges, returns top 50
  const queries = [0, 1, 2, 3].map(shard => {
    let sql = `
      SELECT a.*, u.name as actor_name, u.email as actor_email, e.title as event_title, ${shard} as shard
      FROM audit_logs_${shard} a
      LEFT JOIN users u ON a.actor_id = u.id
      LEFT JOIN events e ON a.event_id = e.id
    `;
    const params = [];

    if (cursorCreatedAt && cursorId) {
      sql += ` WHERE (a.created_at, a.id) < ($1, $2)`;
      params.push(cursorCreatedAt, cursorId);
    }

    sql += ` ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    return db.query(sql, params);
  });

  const results = await Promise.all(queries);
  let allLogs = [];
  results.forEach(res => {
    allLogs = allLogs.concat(res.rows);
  });

  // Sort merged results descending by created_at, then id
  allLogs.sort((a, b) => {
    const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });

  const hasMore = allLogs.length > limit;
  const logs = hasMore ? allLogs.slice(0, limit) : allLogs;

  let nextCursor = null;
  if (hasMore && logs.length > 0) {
    const last = logs[logs.length - 1];
    nextCursor = { created_at: last.created_at, id: last.id };
  }

  return {
    logs,
    nextCursor,
    shardQueried: 'All Shards (0, 1, 2, 3 - Scatter-Gather)',
  };
}

module.exports = {
  writeAudit,
  listAuditLogs,
};
