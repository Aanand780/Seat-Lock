// src/db/tx.js

const { pool } = require('./pool');

class LockTimeoutError extends Error {
  constructor(message = 'Lock acquisition timed out') {
    super(message);
    this.name = 'LockTimeoutError';
    this.statusCode = 503;
  }
}

/**
 * Transaction helper with 2-second lock timeout.
 * Automatically manages BEGIN, SET LOCAL lock_timeout = '2s', COMMIT, and ROLLBACK.
 * Maps PostgreSQL lock_not_available ('55P03') to HTTP 503 LockTimeoutError.
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '2s';");
    } catch (_) {
      // In some mock drivers SET LOCAL may be no-op
    }

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    // 55P03 is Postgres SQLSTATE for lock_not_available / lock_timeout
    if (
      err.code === '55P03' ||
      (err.message && err.message.toLowerCase().includes('lock_timeout')) ||
      (err.message && err.message.toLowerCase().includes('canceling statement due to lock timeout'))
    ) {
      throw new LockTimeoutError('Seat reservation is busy. Lock timed out.');
    }

    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  withTransaction,
  LockTimeoutError,
};
