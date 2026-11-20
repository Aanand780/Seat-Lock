const express = require('express');
const router = express.Router();
const { listAuditLogs } = require('../services/audit.service');
const { requireRole } = require('../middleware/rbac.middleware');
const { listEvents } = require('../services/event.service');

// GET /admin/audit-logs - View sharded audit logs (Admin only)
router.get('/admin/audit-logs', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const eventId = req.query.eventId || null;
    const cursorCreatedAt = req.query.cursorCreatedAt || null;
    const cursorId = req.query.cursorId || null;

    const { logs, nextCursor, shardQueried } = await listAuditLogs(req.user, {
      eventId,
      cursorCreatedAt,
      cursorId,
      limit: 50,
    });

    // Also get all events for dropdown filter
    const events = await listEvents(req.user);

    res.render('audit/index', {
      title: 'Sharded Audit Logs - Admin Console',
      logs,
      nextCursor,
      shardQueried,
      events,
      selectedEventId: eventId || '',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
