const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/rbac.middleware');
const { getAdminSalesDashboard, getAdminEventDashboard } = require('../services/dashboard.service');
const { deny } = require('../utils/deny');

// GET /admin/dashboard - Real-time sales, booking analytics, and remaining tickets
router.get('/admin/dashboard', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const dashboardData = await getAdminSalesDashboard(req.user);
    res.render('admin/dashboard', {
      title: 'Ticket Sales & Capacity Dashboard - SeatLock Admin',
      ...dashboardData,
    });
  } catch (err) {
    if (err.statusCode === 403) {
      return deny(req, res, err.message);
    }
    return next(err);
  }
});

// GET /admin/dashboard/events/:id - Event-specific ticket sales and inventory
router.get('/admin/dashboard/events/:id', requireRole('ADMIN'), async (req, res, next) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId) || eventId < 1) {
    const error = new Error('The requested event could not be found.');
    error.statusCode = 404;
    return next(error);
  }

  try {
    const dashboardData = await getAdminEventDashboard(req.user, eventId);
    res.render('admin/event-dashboard', {
      title: `${dashboardData.event.title} - Ticket Dashboard`,
      dashboardBase: '/admin/dashboard',
      ...dashboardData,
    });
  } catch (err) {
    if (err.statusCode === 403) {
      return deny(req, res, err.message);
    }
    return next(err);
  }
});

module.exports = router;
