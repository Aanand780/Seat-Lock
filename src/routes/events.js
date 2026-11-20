// src/routes/events.js

const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const bookingService = require('../services/bookingService');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Root redirect
router.get('/', (req, res) => {
  res.redirect('/events');
});

// Event list (filtered by role)
router.get('/events', async (req, res, next) => {
  try {
    const events = await eventService.listEvents(req.user);
    res.render('events', {
      title: 'Events - SeatLock',
      events,
      successMsg: req.query.success || null,
    });
  } catch (err) {
    next(err);
  }
});

// Seat Map
router.get('/events/:id/seats', requireAuth, async (req, res, next) => {
  try {
    const seatMapData = await bookingService.getSeatMap(req.user, req.params.id);
    res.render('seatmap', {
      title: `${seatMapData.event.title} - Seat Map`,
      event: seatMapData.event,
      seats: seatMapData.seats,
      userActiveHold: seatMapData.userActiveHold,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

// Hold Seats (1-4 seats)
router.post('/events/:id/hold', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    let seatIds = req.body.seatIds;
    if (!seatIds) {
      return res.redirect(`/events/${req.params.id}/seats?error=${encodeURIComponent('Please select at least 1 seat.')}`);
    }
    if (typeof seatIds === 'string') {
      seatIds = [seatIds];
    }

    const holdResult = await bookingService.holdSeats(req.user, {
      eventId: req.params.id,
      seatIds,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json(holdResult);
    }

    res.redirect(`/events/${req.params.id}/seats?success=${encodeURIComponent('Seats held for 5 minutes! Confirm your booking below.')}`);
  } catch (err) {
    next(err);
  }
});

// Confirm Hold
router.post('/events/:id/confirm', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const confirmResult = await bookingService.confirmHold(req.user, {
      eventId: req.params.id,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json(confirmResult);
    }

    res.redirect('/bookings?success=' + encodeURIComponent('Booking confirmed! Seats successfully reserved.'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
