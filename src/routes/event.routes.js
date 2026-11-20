const express = require('express');
const router = express.Router();
const { listEvents, getEventById, createEvent, updateEvent, deleteEvent } = require('../services/event.service');
const { getSeatMap } = require('../services/booking.service');
const { requireRole, requireEventOwner } = require('../middleware/rbac.middleware');
const { seatEvents } = require('../utils/seatEvents');
const { themePhotoUpload } = require('../middleware/themePhotoUpload');
const { saveEventPhoto, deleteEventPhoto } = require('../utils/eventPhotos');
const { csrfProtection } = require('../middleware/csrf.middleware');

// Root redirect
router.get('/', (req, res) => {
  res.redirect('/events');
});

// GET /events/new - Create event form (Admin/Organizer only)
router.get('/events/new', requireRole('ADMIN', 'ORGANIZER'), (req, res) => {
  res.render('events/new', {
    title: 'Create Event - SeatLock',
    error: null,
    form: { title: '', description: '', venue: '', start_time: '', end_time: '', row_count: '3', seats_per_row: '10', is_published: false },
  });
});

// POST /events/new - Create event and initial seats
router.post('/events/new', requireRole('ADMIN', 'ORGANIZER'), themePhotoUpload, csrfProtection, async (req, res, next) => {
  const { title, description, venue, start_time, end_time, row_count, seats_per_row } = req.body;
  const form = {
    title: title || '',
    description: description || '',
    venue: venue || '',
    start_time: start_time || '',
    end_time: end_time || '',
    row_count: row_count || '',
    seats_per_row: seats_per_row || '',
    is_published: req.body.is_published === 'on',
  };

  let savedPhoto = null;
  try {
    savedPhoto = await saveEventPhoto(req.file);
    const event = await createEvent(req.user, { ...form, theme_photo: savedPhoto, start_time: start_time ? new Date(start_time) : null, end_time: end_time ? new Date(end_time) : null });
    res.redirect(`/events/${event.id}/edit`);
  } catch (err) {
    if (savedPhoto) await deleteEventPhoto(savedPhoto).catch(() => {});
    if (err.statusCode === 400) {
      return res.status(400).render('events/new', {
        title: 'Create Event - SeatLock',
        error: err.message,
        form,
      });
    }
    next(err);
  }
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

// GET /events/:id/seats/stream - Real-time Server-Sent Events (SSE) stream for seat map
router.get('/events/:id/seats/stream', async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', eventId, timestamp: Date.now() })}\n\n`);

  const onSeatUpdate = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  seatEvents.on(`seat-update:${eventId}`, onSeatUpdate);

  req.on('close', () => {
    seatEvents.off(`seat-update:${eventId}`, onSeatUpdate);
  });
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
router.post('/events/:id/edit', requireRole('ADMIN', 'ORGANIZER'), requireEventOwner, themePhotoUpload, csrfProtection, async (req, res, next) => {
  let savedPhoto = null;
  try {
    const eventId = parseInt(req.params.id, 10);
    const { title, description, venue, start_time, end_time, is_published, version } = req.body;
    const currentEvent = await getEventById(req.user, eventId);
    savedPhoto = await saveEventPhoto(req.file);

    const updatedEvent = await updateEvent(req.user, eventId, {
      title,
      description,
      venue,
      start_time: start_time ? new Date(start_time) : undefined,
      end_time: end_time ? new Date(end_time) : undefined,
      is_published: is_published === 'on' || is_published === 'true' || is_published === true,
      theme_photo: savedPhoto || undefined,
      version: parseInt(version, 10),
    });

    if (savedPhoto && currentEvent.theme_photo) await deleteEventPhoto(currentEvent.theme_photo).catch(() => {});
    res.redirect(`/events`);
  } catch (err) {
    if (savedPhoto) await deleteEventPhoto(savedPhoto).catch(() => {});
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

router.post('/admin/events/:id/delete', requireRole('ADMIN'), async (req, res, next) => {
  try {
    await deleteEvent(req.user, parseInt(req.params.id, 10));
    res.redirect('/events');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
