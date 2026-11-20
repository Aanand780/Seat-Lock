const express = require('express');
const router = express.Router();
const {
  holdSeats,
  confirmHold,
  cancelBooking,
  toggleSeatBlock,
  listMyBookings,
} = require('../services/booking.service');
const { requireLogin, requireRole } = require('../middleware/rbac.middleware');

// GET /my-bookings - Student bookings & active holds
router.get('/my-bookings', requireRole('STUDENT', 'ADMIN'), async (req, res, next) => {
  try {
    const { activeHolds, bookings } = await listMyBookings(req.user);

    res.render('bookings/my-bookings', {
      title: 'My Seat Bookings - SeatLock',
      activeHolds,
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

// POST /events/:id/hold - Student holds 1 to 4 seats
router.post('/events/:id/hold', requireRole('STUDENT', 'ADMIN'), async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    let seatIds = req.body.seatIds;

    if (!seatIds) {
      const err = new Error('Please select at least 1 seat to hold');
      err.statusCode = 400;
      throw err;
    }

    // Handle single string or array of strings
    if (!Array.isArray(seatIds)) {
      seatIds = [seatIds];
    }

    const result = await holdSeats(req.user, eventId, seatIds);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(200).json(result);
    }

    return res.redirect('/my-bookings');
  } catch (err) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(err.statusCode || 500).json({
        error: err.message,
        unavailableSeatIds: err.unavailableSeatIds || [],
      });
    }
    next(err);
  }
});

// POST /holds/:id/confirm - Student confirms own active hold
router.post('/holds/:id/confirm', requireRole('STUDENT', 'ADMIN'), async (req, res, next) => {
  try {
    const holdId = parseInt(req.params.id, 10);
    const result = await confirmHold(req.user, holdId);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(200).json(result);
    }

    return res.redirect('/my-bookings');
  } catch (err) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    next(err);
  }
});

// POST /bookings/:id/cancel - Student cancels own confirmed booking
router.post('/bookings/:id/cancel', requireRole('STUDENT', 'ADMIN'), async (req, res, next) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    const result = await cancelBooking(req.user, bookingId);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(200).json(result);
    }

    return res.redirect('/my-bookings');
  } catch (err) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    next(err);
  }
});

// POST /events/:id/seats/:seatId/block - Organizer/Admin seat blocking
router.post('/events/:id/seats/:seatId/block', requireRole('ORGANIZER', 'ADMIN'), async (req, res, next) => {
  try {
    const seatId = parseInt(req.params.seatId, 10);
    const eventId = parseInt(req.params.id, 10);

    const result = await toggleSeatBlock(req.user, seatId);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(200).json(result);
    }

    return res.redirect(`/events/${eventId}/seats`);
  } catch (err) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
