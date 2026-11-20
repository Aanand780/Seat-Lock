const express = require('express');
const router = express.Router();
const { listEventBookings, checkIn, getEventById } = require('../services/event.service');
const { requireRole, requireEventOwner } = require('../middleware/rbac.middleware');
const { deny } = require('../utils/deny');

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
