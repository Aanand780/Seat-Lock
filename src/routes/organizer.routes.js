const express = require('express');
const router = express.Router();
const { listEventBookings, checkIn, getEventById } = require('../services/event.service');
const { requireRole, requireEventOwner } = require('../middleware/rbac.middleware');
const { deny } = require('../utils/deny');
const { getOrganizerSalesDashboard, getOrganizerEventDashboard } = require('../services/dashboard.service');

// GET /organizer/dashboard - Sales and inventory for the organizer's own events
router.get('/organizer/dashboard', requireRole('ORGANIZER'), async (req, res, next) => {
  try {
    const dashboardData = await getOrganizerSalesDashboard(req.user);
    res.render('organizer/dashboard', {
      title: 'My Event Sales Dashboard - SeatLock',
      ...dashboardData,
    });
  } catch (err) {
    if (err.statusCode === 403) {
      return deny(req, res, err.message);
    }
    return next(err);
  }
});

// GET /organizer/dashboard/events/:id - Details for one owned event
router.get('/organizer/dashboard/events/:id', requireRole('ORGANIZER'), requireEventOwner, async (req, res, next) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId) || eventId < 1) {
    const error = new Error('The requested event could not be found.');
    error.statusCode = 404;
    return next(error);
  }

  try {
    const dashboardData = await getOrganizerEventDashboard(req.user, eventId);
    res.render('admin/event-dashboard', {
      title: `${dashboardData.event.title} - Ticket Dashboard`,
      dashboardBase: '/organizer/dashboard',
      ...dashboardData,
    });
  } catch (err) {
    if (err.statusCode === 403) {
      return deny(req, res, err.message, { eventId: req.params.id });
    }
    return next(err);
  }
});

// GET /organizer/events/:id/attendees
router.get('/organizer/events/:id/attendees', requireRole('ORGANIZER', 'ADMIN'), requireEventOwner, async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await getEventById(req.user, eventId);
    const bookings = await listEventBookings(req.user, eventId);

    res.render('events/attendees', {
      title: `${event.title} - Attendees`,
      event,
      bookings,
    });
  } catch (err) {
    if (err.statusCode === 403) {
      return deny(req, res, err.message, { eventId: req.params.id });
    }
    next(err);
  }
});

// POST /organizer/bookings/:id/checkin
router.post('/organizer/bookings/:id/checkin', requireRole('ORGANIZER', 'ADMIN'), async (req, res, next) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    const result = await checkIn(req.user, bookingId);

    const redirectUrl = req.body.redirectUrl || '/events';
    res.redirect(redirectUrl);
  } catch (err) {
    if (err.statusCode === 403) {
      return deny(req, res, err.message, { bookingId: req.params.id });
    }
    next(err);
  }
});

module.exports = router;
