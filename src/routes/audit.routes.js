const express = require('express');
const router = express.Router();
const { listAuditLogs } = require('../services/audit.service');
const { requireRole } = require('../middleware/rbac.middleware');
const { listEvents } = require('../services/event.service');

// GET /admin/audit-logs - View sharded audit logs (Admin only)
router.get('/admin/audit-logs', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const eventId = req.query.eventId || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const cursor = req.query.cursor || null;

    const { logs, nextCursor, shardQueried, executedSql } = await listAuditLogs(req.user, {
      eventId,
      dateFrom,
      dateTo,
      cursor,
      limit: 50,
    });

    // Also get all events for dropdown filter
    const events = await listEvents(req.user);

    res.render('audit/index', {
      title: 'Sharded Audit Logs - Admin Console',
      logs,
      nextCursor,
      shardQueried,
      executedSql,
      events,
      selectedEventId: eventId || '',
      dateFrom: dateFrom || '',
      dateTo: dateTo || '',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
