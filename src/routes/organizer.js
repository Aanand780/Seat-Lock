// src/routes/organizer.js

const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const { requireRole } = require('../middleware/rbac');

// Enforce organizer or admin role on all organizer routes
router.use(requireRole('organizer', 'admin'));

// Form to create event
router.get('/organizer/events/new', (req, res) => {
  res.render('event-form', {
    title: 'Create Event - SeatLock',
    event: null,
    isEdit: false,
    errorMsg: null,
  });
});

// Create event
router.post('/organizer/events', async (req, res, next) => {
  try {
    const newEvent = await eventService.createEvent(req.user, req.body);
    res.redirect(`/events/${newEvent.id}/seats?success=${encodeURIComponent('Event created with 50 seats!')}`);
  } catch (err) {
    next(err);
  }
});

// Form to edit event (includes hidden version)
router.get('/organizer/events/:id/edit', async (req, res, next) => {
  try {
    const event = await eventService.getEventById(req.user, req.params.id);
    if (!event) return res.status(404).render('404', { title: 'Not Found' });

    res.render('event-form', {
      title: `Edit ${event.title}`,
      event,
      isEdit: true,
      errorMsg: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

// Update event with optimistic locking
router.post('/organizer/events/:id/edit', async (req, res, next) => {
  try {
    await eventService.updateEvent(req.user, req.params.id, req.body);
    res.redirect('/events?success=' + encodeURIComponent('Event updated successfully.'));
  } catch (err) {
    next(err);
  }
});

// View attendees for own event
router.get('/organizer/events/:id/attendees', async (req, res, next) => {
  try {
    const data = await eventService.listEventBookings(req.user, req.params.id);
    res.render('attendees', {
      title: `Attendees - ${data.event.title}`,
      event: data.event,
      attendees: data.attendees,
      successMsg: req.query.success || null,
    });
  } catch (err) {
    next(err);
  }
});

// Check in attendee
router.post('/organizer/events/:id/checkin', async (req, res, next) => {
  try {
    const { bookingId } = req.body;
    await eventService.checkIn(req.user, {
      eventId: req.params.id,
      bookingId,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, bookingId });
    }

    res.redirect(`/organizer/events/${req.params.id}/attendees?success=${encodeURIComponent('Attendee checked in!')}`);
  } catch (err) {
    next(err);
  }
});

// Block/unblock seat
router.post('/organizer/events/:id/seats/block', async (req, res, next) => {
  try {
    const { seatId, isBlocked } = req.body;
    await eventService.blockSeat(req.user, {
      eventId: req.params.id,
      seatId,
      isBlocked: isBlocked === 'true' || isBlocked === true,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true });
    }

    res.redirect(`/events/${req.params.id}/seats?success=${encodeURIComponent('Seat status updated.')}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
