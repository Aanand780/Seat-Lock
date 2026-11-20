const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { getAuditShard } = require('../utils/sharding');

/**
 * Encode cursor (created_at, id) into URL-safe base64 string
 */
function encodeCursor(created_at, id) {
  if (!created_at || !id) return null;
  const payload = JSON.stringify({ created_at: new Date(created_at).toISOString(), id });
  return Buffer.from(payload).toString('base64');
}

/**
 * Decode base64 cursor into { created_at, id }
 */
function decodeCursor(cursorStr) {
  if (!cursorStr) return null;
  try {
    const raw = Buffer.from(cursorStr, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed.created_at && parsed.id) {
      return parsed;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Write an audit record across the 4 sharded audit tables.
 * Shard = stable_hash(event_id) mod 4; for non-event actions use actor_id.
 *
 * Supports flexible invocations:
 *   writeAudit(client, { action, actorId, actorRole, eventId, details })
 *   writeAudit(currentUser, { action, actorId, actorRole, eventId, details }, client)
 *
 * @param {object|null} firstArg - Either pg client or currentUser
 * @param {object} params
 * @param {string} params.action - LOGIN, LOGIN_FAILED, SEAT_HOLD, SEAT_HOLD_REJECTED, HOLD_EXPIRED,
 *                                  BOOKING_CONFIRMED, BOOKING_CANCELLED, EVENT_UPDATED, CHECKIN, ACCESS_DENIED
 * @param {number|null} [params.actorId=null]
 * @param {string|null} [params.actorRole=null]
 * @param {number|null} [params.eventId=null]
 * @param {object} [params.details={}]
 * @param {object} [optionalClient=null]
 * @returns {Promise<object>} The inserted audit record with .shard
 */
async function writeAudit(firstArg, params = {}, optionalClient = null) {
  let client = null;
  let currentUser = null;

  if (firstArg && typeof firstArg.query === 'function') {
    client = firstArg;
  } else {
    currentUser = firstArg;
    client = optionalClient || params.client || null;
  }

  const finalActorId = params.actorId !== undefined ? params.actorId : (currentUser ? currentUser.id : null);
  const finalActorRole = params.actorRole !== undefined ? params.actorRole : (currentUser ? currentUser.role : null);
  const finalEventId = params.eventId !== undefined ? params.eventId : null;
  const action = params.action;
  const details = params.details || {};

  const shardIndex = getAuditShard(finalEventId, finalActorId);
  const tableName = `audit_logs_${shardIndex}`;
  const id = uuidv4();
  const now = new Date();

  const queryText = `
    INSERT INTO ${tableName} (id, actor_id, actor_role, action, event_id, details, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;
  const queryParams = [
    id,
    finalActorId,
    finalActorRole,
    action,
    finalEventId,
    JSON.stringify(details),
    now
  ];

  const executor = client || db;
  const result = await executor.query(queryText, queryParams);
  const row = result.rows[0];

  return {
    ...row,
    shard: shardIndex,
  };
}

/**
 * List audit logs with role check, shard pruning, date filtering, and cursor pagination.
 *
 * - Admin only.
 * - Event filter reads ONE shard (pruned).
 * - No filter reads all four shards (scatter-gather), merges, and returns latest 50.
 *
 * @param {object} currentUser - Must have ADMIN role
 * @param {object} options
 * @param {number|string|null} options.eventId
 * @param {string|null} options.dateFrom
 * @param {string|null} options.dateTo
 * @param {string|null} options.cursor - Base64 encoded (created_at, id)
 * @param {string|null} options.cursorCreatedAt - Direct timestamp cursor
 * @param {string|null} options.cursorId - Direct id cursor
 * @param {number} [options.limit=50]
 * @returns {Promise<{ logs: Array, nextCursor: string|null, nextCursorObj: object|null, shardQueried: string, executedSql: Array<string> }>}
 */
async function listAuditLogs(currentUser, {
  eventId = null,
  dateFrom = null,
  dateTo = null,
  cursor = null,
  cursorCreatedAt = null,
  cursorId = null,
  limit = 50
} = {}) {
  // 1. Role verification inside service
  if (!currentUser || currentUser.role !== 'ADMIN') {
    const error = new Error('Access denied: listAuditLogs requires ADMIN role');
    error.statusCode = 403;
    throw error;
  }

  // Parse cursor if provided as base64 string
  let parsedCursor = decodeCursor(cursor);
  let effectiveCursorCreatedAt = parsedCursor ? parsedCursor.created_at : cursorCreatedAt;
  let effectiveCursorId = parsedCursor ? parsedCursor.id : cursorId;

  // Track executed SQL for demo and acceptance verification
  const executedSql = [];

  // 2. Event-filtered query: Reads exactly ONE shard (Shard Pruning)
  if (eventId !== null && eventId !== undefined && eventId !== '') {
    const parsedEventId = parseInt(eventId, 10);
    const shardIndex = getAuditShard(parsedEventId, null);
    const tableName = `audit_logs_${shardIndex}`;

    let sql = `SELECT a.*, u.name as actor_name, u.email as actor_email, e.title as event_title, ${shardIndex} as shard ` +
              `FROM ${tableName} a ` +
              `LEFT JOIN users u ON a.actor_id = u.id ` +
              `LEFT JOIN events e ON a.event_id = e.id ` +
              `WHERE a.event_id = $1`;
    const params = [parsedEventId];

    if (dateFrom) {
      params.push(new Date(dateFrom).toISOString());
      sql += ` AND a.created_at >= $${params.length}`;
    }

    if (dateTo) {
      // Inclusive of end-of-day if only YYYY-MM-DD passed
      const toDate = new Date(dateTo);
      if (dateTo.length <= 10) {
        toDate.setHours(23, 59, 59, 999);
      }
      params.push(toDate.toISOString());
      sql += ` AND a.created_at <= $${params.length}`;
    }

    if (effectiveCursorCreatedAt && effectiveCursorId) {
      params.push(effectiveCursorCreatedAt, effectiveCursorId);
      sql += ` AND (a.created_at, a.id) < ($${params.length - 1}, $${params.length})`;
    }

    params.push(limit + 1);
    sql += ` ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`;

    executedSql.push(`[Shard ${shardIndex}] ${sql} -- Params: ${JSON.stringify(params)}`);

    const result = await db.query(sql, params);
    const hasMore = result.rows.length > limit;
    const logs = hasMore ? result.rows.slice(0, limit) : result.rows;

    let nextCursor = null;
    let nextCursorObj = null;
    if (hasMore && logs.length > 0) {
      const last = logs[logs.length - 1];
      nextCursorObj = { created_at: last.created_at, id: last.id };
      nextCursor = encodeCursor(last.created_at, last.id);
    }

    return {
      logs,
      nextCursor,
      nextCursorObj,
      shardQueried: `audit_logs_${shardIndex} (Pruned by event_id=${parsedEventId})`,
      executedSql,
    };
  }

  // 3. Unfiltered query: Scatter-gather across all four shards (0..3)
  const shardPromises = [0, 1, 2, 3].map((shard) => {
    let sql = `SELECT a.*, u.name as actor_name, u.email as actor_email, e.title as event_title, ${shard} as shard ` +
              `FROM audit_logs_${shard} a ` +
              `LEFT JOIN users u ON a.actor_id = u.id ` +
              `LEFT JOIN events e ON a.event_id = e.id ` +
              `WHERE 1=1`;
    const params = [];

    if (dateFrom) {
      params.push(new Date(dateFrom).toISOString());
      sql += ` AND a.created_at >= $${params.length}`;
    }

    if (dateTo) {
      const toDate = new Date(dateTo);
      if (dateTo.length <= 10) {
        toDate.setHours(23, 59, 59, 999);
      }
      params.push(toDate.toISOString());
      sql += ` AND a.created_at <= $${params.length}`;
    }

    if (effectiveCursorCreatedAt && effectiveCursorId) {
      params.push(effectiveCursorCreatedAt, effectiveCursorId);
      sql += ` AND (a.created_at, a.id) < ($${params.length - 1}, $${params.length})`;
    }

    params.push(limit);
    sql += ` ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`;

    executedSql.push(`[Shard ${shard}] ${sql} -- Params: ${JSON.stringify(params)}`);

    return db.query(sql, params);
  });

  const results = await Promise.all(shardPromises);
  let allLogs = [];
  results.forEach(res => {
    allLogs = allLogs.concat(res.rows);
  });

  // Merge and sort in-memory by (created_at DESC, id DESC)
  allLogs.sort((a, b) => {
    const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });

  const hasMore = allLogs.length > limit;
  const logs = hasMore ? allLogs.slice(0, limit) : allLogs;

  let nextCursor = null;
  let nextCursorObj = null;
  if (hasMore && logs.length > 0) {
    const last = logs[logs.length - 1];
    nextCursorObj = { created_at: last.created_at, id: last.id };
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  return {
    logs,
    nextCursor,
    nextCursorObj,
    shardQueried: 'audit_logs_0, audit_logs_1, audit_logs_2, audit_logs_3 (Scatter-Gather)',
    executedSql,
  };
}

module.exports = {
  writeAudit,
  listAuditLogs,
  encodeCursor,
  decodeCursor,
};
