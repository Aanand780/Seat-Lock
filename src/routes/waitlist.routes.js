const express = require('express');
const router = express.Router();
const { joinWaitlist, leaveWaitlist } = require('../services/waitlist.service');
const { requireRole } = require('../middleware/rbac.middleware');

// POST /events/:id/waitlist - Join event waitlist
router.post('/events/:id/waitlist', requireRole('STUDENT', 'ADMIN'), async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const requestedSeats = parseInt(req.body.seatsCount, 10) || 1;

    const entry = await joinWaitlist(req.user, eventId, requestedSeats);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(200).json({ success: true, waitlist: entry });
    }

    res.redirect(`/events/${eventId}/seats`);
  } catch (err) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    next(err);
  }
});

// POST /events/:id/waitlist/leave - Leave event waitlist
router.post('/events/:id/waitlist/leave', requireRole('STUDENT', 'ADMIN'), async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const result = await leaveWaitlist(req.user, eventId);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(200).json(result);
    }

    res.redirect(`/events/${eventId}/seats`);
  } catch (err) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
