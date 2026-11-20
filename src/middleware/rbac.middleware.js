const { deny } = require('../utils/deny');
const db = require('../config/db');

/**
 * Require user to be authenticated.
 */
function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Please log in to continue' });
    }
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

/**
 * Require user to hold one of the specified roles.
 * Triggers deny() and ACCESS_DENIED audit log on failure.
 *
 * @param  {...string} allowedRoles - 'ADMIN', 'ORGANIZER', 'STUDENT'
 */
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.user) {
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }

    if (!allowedRoles.includes(req.user.role)) {
      return deny(req, res, `Role '${req.user.role}' is not authorized. Required: ${allowedRoles.join(', ')}`, {
        requiredRoles: allowedRoles,
        userRole: req.user.role,
      });
    }

    next();
  };
}

/**
 * Require user to be an ADMIN or the ORGANIZER owning the event.
 */
async function requireEventOwner(req, res, next) {
  if (!req.user) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  if (req.user.role === 'ADMIN') {
    return next();
  }

  if (req.user.role !== 'ORGANIZER') {
    return deny(req, res, 'Only event organizers or admins can perform this action', {
      userRole: req.user.role,
    });
  }

  const eventId = req.params.id || req.params.eventId;
  if (!eventId) {
    return next();
  }

  try {
    const result = await db.query('SELECT organizer_id FROM events WHERE id = $1', [eventId]);
    const event = result.rows[0];

    if (!event) {
      return res.status(404).render('errors/404', {
        title: 'Event Not Found',
        message: 'The requested event does not exist.',
        user: req.user,
      });
    }

    if (event.organizer_id !== req.user.id) {
      return deny(req, res, 'Organizers may only access and manage their own events', {
        eventOrganizerId: event.organizer_id,
        currentUserId: req.user.id,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireLogin,
  requireRole,
  requireEventOwner,
};
