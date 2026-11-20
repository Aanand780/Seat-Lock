// src/jobs/holdExpirySweeper.js

const { pool } = require('../db/pool');
const { writeAudit } = require('../services/auditService');

let intervalId = null;

/**
 * Periodically deletes expired holds and logs HOLD_EXPIRED audit events.
 * Note: Core booking correctness is lazy and never depends on this sweeper,
 * but the sweeper frees up rows and creates auditable records.
 */
async function sweepExpiredHolds() {
  try {
    // Find all expired holds
    const res = await pool.query(
      `SELECT h.id, h.event_id, h.user_id, h.seat_id, s.seat_number 
       FROM holds h
       JOIN seats s ON h.seat_id = s.id
       WHERE h.expires_at <= now()`
    );

    if (res.rows.length === 0) return;

    const expiredIds = res.rows.map(r => r.id);
    const placeholders = expiredIds.map((_, i) => `$${i + 1}`).join(', ');

    // Delete them
    await pool.query(`DELETE FROM holds WHERE id IN (${placeholders})`, expiredIds);

    // Record audit records for each
    for (const hold of res.rows) {
      await writeAudit({
        eventId: hold.event_id,
        actorId: hold.user_id,
        action: 'HOLD_EXPIRED',
        details: {
          holdId: hold.id,
          seatId: hold.seat_id,
          seatNumber: hold.seat_number,
          reason: '5_minute_timeout'
        }
      });
    }

    console.log(`[Sweeper] Cleaned up ${expiredIds.length} expired seat hold(s).`);
  } catch (err) {
    // Avoid crashing on transient connection error during shutdown
    console.error('[Sweeper Error]', err.message);
  }
}

function startSweeper(intervalMs = 30000) {
  if (intervalId) return;
  console.log(`[Sweeper] Hold-expiry sweeper started (running every ${intervalMs / 1000}s)`);
  // Run once immediately
  sweepExpiredHolds();
  intervalId = setInterval(sweepExpiredHolds, intervalMs);
}

function stopSweeper() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Sweeper] Sweeper stopped.');
  }
}

module.exports = {
  sweepExpiredHolds,
  startSweeper,
  stopSweeper,
};
