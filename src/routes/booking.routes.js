const express = require('express');
const router = express.Router();
const { listMyBookings } = require('../services/booking.service');
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

module.exports = router;
