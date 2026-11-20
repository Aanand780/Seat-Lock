const express = require('express');
const router = express.Router();
const { listEvents, getEventById, updateEvent } = require('../services/event.service');
const { getSeatMap } = require('../services/booking.service');
const { requireRole, requireEventOwner } = require('../middleware/rbac.middleware');

// Root redirect
router.get('/', (req, res) => {
  res.redirect('/events');
});

// GET /events - Role-aware event list
router.get('/events', async (req, res, next) => {
  try {
    const events = await listEvents(req.user);
    res.render('events/index', {
      title: 'College Fest Events - SeatLock',
      events,
    });
  } catch (err) {
    next(err);
  }
});

// GET /events/:id/seats - SSR Seat Map
router.get('/events/:id/seats', async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await getEventById(req.user, eventId);
    const seats = await getSeatMap(req.user, eventId);

    // Group seats by row
    const seatsByRow = {};
    seats.forEach(s => {
      if (!seatsByRow[s.row_label]) seatsByRow[s.row_label] = [];
      seatsByRow[s.row_label].push(s);
    });

    res.render('events/seat-map', {
      title: `${event.title} - Seat Map`,
      event,
      seatsByRow,
    });
  } catch (err) {
    next(err);
  }
});

// GET /events/:id/edit - Edit event page (Organizer/Admin only)
router.get('/events/:id/edit', requireRole('ADMIN', 'ORGANIZER'), requireEventOwner, async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await getEventById(req.user, eventId);

    res.render('events/edit', {
      title: `Edit ${event.title}`,
      event,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /events/:id/edit - Optimistic locking update
router.post('/events/:id/edit', requireRole('ADMIN', 'ORGANIZER'), requireEventOwner, async (req, res, next) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { title, description, venue, start_time, is_published, version } = req.body;

    const updatedEvent = await updateEvent(req.user, eventId, {
      title,
      description,
      venue,
      start_time: start_time ? new Date(start_time) : undefined,
      is_published: is_published === 'on' || is_published === 'true' || is_published === true,
      version: parseInt(version, 10),
    });

    res.redirect(`/events`);
  } catch (err) {
    if (err.statusCode === 409) {
      // Re-fetch current version and render conflict error
      const eventId = parseInt(req.params.id, 10);
      try {
        const freshEvent = await getEventById(req.user, eventId);
        return res.status(409).render('events/edit', {
          title: `Conflict: Edit ${freshEvent.title}`,
          event: freshEvent,
          error: 'Version conflict! Another organizer or administrator updated this event while you were editing. The form has been updated with the latest data.',
        });
      } catch (inner) {
        return next(err);
      }
    }
    next(err);
  }
});

module.exports = router;
