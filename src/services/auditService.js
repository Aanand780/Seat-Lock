// src/services/auditService.js

const { shardFor, SHARDS } = require('../db/shardRouter');
const { pool } = require('../db/pool');
const { v7: uuidv7 } = require('uuid');

class ForbiddenError extends Error {
  constructor(message = 'Access Denied') {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

/**
 * Writes an audit record to the appropriate shard.
 * Pass the open transaction client for booking actions so it rolls back with the transaction.
 * Omit client for independent actions like LOGIN, LOGIN_FAILED, ACCESS_DENIED.
 */
async function writeAudit(entry, client = pool) {
  const shard = shardFor(entry.eventId, entry.actorId);
  const id = uuidv7();
  const detailsJson = typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details ?? {});

  await client.query(
    `INSERT INTO audit_logs_${shard}
       (id, event_id, actor_id, action, details, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      id,
      entry.eventId ?? null,
      entry.actorId,
      entry.action,
      detailsJson
    ]
  );

  return { id, shard };
}

/**
 * Reads audit records with role verification, shard pruning, and scatter-gather merge.
 * Admins can filter by eventId and date range.
 */
async function listAuditLogs(currentUser, options = {}) {
  // Service-level permission check
  if (!currentUser || currentUser.role !== 'admin') {
    throw new ForbiddenError('Only administrators may view audit logs.');
  }

  const { eventId, startDate, endDate, cursor, limit = 50 } = options;
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

  // Helper to build WHERE conditions for an individual shard query
  function buildQuery(shardIndex) {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (eventId) {
      conditions.push(`event_id = $${paramIdx++}`);
      params.push(eventId);
    }
    if (startDate) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(new Date(startDate));
    }
    if (endDate) {
      conditions.push(`created_at <= $${paramIdx++}`);
      params.push(new Date(endDate));
    }
    if (cursor) {
      try {
        const [cursorTime, cursorId] = Buffer.from(cursor, 'base64').toString('utf8').split('###');
        conditions.push(`(created_at, id) < ($${paramIdx++}, $${paramIdx++})`);
        params.push(new Date(cursorTime), cursorId);
      } catch (_) {
        // ignore malformed cursor
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT id, event_id, actor_id, action, details, created_at, '${shardIndex}' as shard
      FROM audit_logs_${shardIndex}
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${parsedLimit + 1}
    `;
    return { sql, params };
  }

  let rows = [];
  let queriedShards = [];

  if (eventId) {
    // Shard pruning: Query ONLY the specific shard
    const targetShard = shardFor(eventId, null);
    queriedShards = [targetShard];
    const { sql, params } = buildQuery(targetShard);
    const result = await pool.query(sql, params);
    rows = result.rows;
  } else {
    // Scatter-gather: Query all 4 shards in parallel
    queriedShards = [0, 1, 2, 3];
    const promises = queriedShards.map(shardIdx => {
      const { sql, params } = buildQuery(shardIdx);
      return pool.query(sql, params).then(res => res.rows);
    });

    const shardResults = await Promise.all(promises);
    const combined = [].concat(...shardResults);

    // Merge sort by (created_at DESC, id DESC)
    combined.sort((a, b) => {
      const timeDiff = new Date(b.created_at) - new Date(a.created_at);
      if (timeDiff !== 0) return timeDiff;
      return String(b.id).localeCompare(String(a.id));
    });

    rows = combined;
  }

  // Parse details JSON
  rows = rows.map(r => ({
    ...r,
    details: typeof r.details === 'string' ? (r.details ? JSON.parse(r.details) : {}) : (r.details || {})
  }));

  const hasMore = rows.length > parsedLimit;
  const pagedRows = rows.slice(0, parsedLimit);

  let nextCursor = null;
  if (hasMore && pagedRows.length > 0) {
    const last = pagedRows[pagedRows.length - 1];
    nextCursor = Buffer.from(`${new Date(last.created_at).toISOString()}###${last.id}`).toString('base64');
  }

  return {
    logs: pagedRows,
    nextCursor,
    queriedShards,
    isPruned: !!eventId,
  };
}

module.exports = {
  writeAudit,
  listAuditLogs,
  ForbiddenError,
};
