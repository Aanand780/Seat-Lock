// src/routes/admin.js

const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const eventService = require('../services/eventService');
const auditService = require('../services/auditService');
const { requireRole } = require('../middleware/rbac');

// Enforce admin role on all admin routes
router.use(requireRole('admin'));

// Admin User Management
router.get('/admin/users', async (req, res, next) => {
  try {
    const users = await userService.listUsers(req.user);
    res.render('users', {
      title: 'User Management - SeatLock',
      users,
      successMsg: req.query.success || null,
    });
  } catch (err) {
    next(err);
  }
});

// Update role
router.post('/admin/users/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body;
    await userService.updateUserRole(req.user, req.params.id, role);
    res.redirect('/admin/users?success=' + encodeURIComponent('User role updated successfully.'));
  } catch (err) {
    next(err);
  }
});

// Admin Audit Viewer
router.get('/admin/audit', async (req, res, next) => {
  try {
    const { eventId, startDate, endDate, cursor } = req.query;
    const events = await eventService.listEvents(req.user);

    const auditData = await auditService.listAuditLogs(req.user, {
      eventId: eventId || null,
      startDate: startDate || null,
      endDate: endDate || null,
      cursor: cursor || null,
      limit: 50,
    });

    res.render('audit', {
      title: 'Audit Logs - SeatLock',
      events,
      logs: auditData.logs,
      nextCursor: auditData.nextCursor,
      queriedShards: auditData.queriedShards,
      isPruned: auditData.isPruned,
      selectedEventId: eventId || '',
      startDate: startDate || '',
      endDate: endDate || '',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
