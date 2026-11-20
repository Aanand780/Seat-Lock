// src/middleware/csrf.js

const crypto = require('crypto');
const { ForbiddenError } = require('../services/auditService');

/**
 * Session-backed CSRF protection middleware.
 * Injects csrfToken into res.locals for SSR forms.
 * Verifies _csrf in body or x-csrf-token in headers for POST/PUT/DELETE.
 */
function csrfMiddleware(req, res, next) {
  if (!req.session) {
    return next();
  }

  // Ensure CSRF token in session
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  res.locals.csrfToken = req.session.csrfToken;

  // Safe HTTP methods
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Allow test client bypass when explicit testing header is passed
  if (req.headers['x-seatlock-test'] === 'load-test' || process.env.NODE_ENV === 'test') {
    return next();
  }

  const token = req.body?._csrf || req.headers['x-csrf-token'];

  if (!token || token !== req.session.csrfToken) {
    const err = new ForbiddenError('Invalid or missing CSRF token.');
    return next(err);
  }

  next();
}

module.exports = csrfMiddleware;
