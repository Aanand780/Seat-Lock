// src/routes/bookings.js

const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// View student's bookings
router.get('/bookings', requireAuth, requireRole('student', 'admin'), async (req, res, next) => {
  try {
    const bookings = await bookingService.listMyBookings(req.user);
    res.render('bookings', {
      title: 'My Bookings - SeatLock',
      bookings,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

// Cancel a booking
router.post('/bookings/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    await bookingService.cancelBooking(req.user, req.params.id);

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, bookingId: req.params.id });
    }

    res.redirect('/bookings?success=' + encodeURIComponent('Booking cancelled successfully.'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
