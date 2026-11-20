// src/middleware/errors.js

const { writeAudit, ForbiddenError } = require('../services/auditService');
const { ConflictError } = require('../services/eventService');
const { LockTimeoutError } = require('../db/tx');

/**
 * Central Error Handler:
 * - 403: writes ACCESS_DENIED audit log on separate connection, renders 403 page
 * - 409: renders 409 conflict page (with unavailable seats or version collision message)
 * - 503: renders 503 lock timeout page
 * - 500: generic server error page
 */
async function errorHandler(err, req, res, next) {
  const isJson = req.xhr || req.headers.accept?.includes('application/json');
  const currentUser = req.user || null;
  const actorId = currentUser ? currentUser.id : 'anonymous';
  const eventId = req.params?.eventId || req.params?.id || req.body?.eventId || null;

  // 1. Handle HTTP 403 Forbidden
  if (err instanceof ForbiddenError || err.statusCode === 403 || err.status === 403) {
    try {
      // Record ACCESS_DENIED on separate connection so it survives transaction rollback
      await writeAudit({
        eventId,
        actorId,
        action: 'ACCESS_DENIED',
        details: {
          path: req.originalUrl,
          method: req.method,
          userRole: currentUser?.role || 'unauthenticated',
          reason: err.message,
        }
      });
    } catch (auditErr) {
      console.error('[Audit Error on ACCESS_DENIED]', auditErr.message);
    }

    res.status(403);
    if (isJson) {
      return res.json({ error: 'Access Denied', message: err.message });
    }
    return res.render('403', {
      title: '403 Forbidden',
      message: err.message || 'You do not have permission to access this resource.',
      currentUser,
    });
  }

  // 2. Handle HTTP 409 Conflict
  if (err instanceof ConflictError || err.statusCode === 409 || err.status === 409) {
    res.status(409);
    if (isJson) {
      return res.json({
        error: 'Conflict',
        message: err.message,
        unavailableSeats: err.details?.unavailableSeats || [],
        details: err.details,
      });
    }
    return res.render('409', {
      title: '409 Conflict',
      message: err.message || 'A conflicting reservation or concurrent modification occurred.',
      unavailableSeats: err.details?.unavailableSeats || [],
      eventId: eventId || null,
      currentUser,
    });
  }

  // 3. Handle HTTP 503 Lock Timeout
  if (err instanceof LockTimeoutError || err.statusCode === 503 || err.status === 503) {
    res.status(503);
    if (isJson) {
      return res.json({
        error: 'Service Unavailable',
        message: 'High demand! The reservation lock timed out. Please try again.',
      });
    }
    return res.render('503', {
      title: '503 Service Busy',
      message: 'The seat reservation system is currently experiencing high demand. Please try again in a few moments.',
      currentUser,
    });
  }

  // 4. Generic 500 Server Error
  console.error('[Server Error]', err);
  const status = err.statusCode || err.status || 500;
  res.status(status);

  if (isJson) {
    return res.json({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message,
    });
  }

  return res.render('error', {
    title: 'Error',
    message: err.message || 'An unexpected error occurred.',
    statusCode: status,
    currentUser,
  });
}

module.exports = errorHandler;
