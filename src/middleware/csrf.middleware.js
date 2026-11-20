const crypto = require('crypto');

/**
 * Custom secure CSRF protection middleware.
 * Stores a cryptographically secure token in the server-side session.
 * Exposes res.locals.csrfToken for EJS forms.
 * Validates token on non-idempotent methods (POST, PUT, DELETE, PATCH).
 */
function csrfProtection(req, res, next) {
  if (!req.session) {
    return next();
  }

  // Ensure session has a CSRF token
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  // Make token available to all templates
  res.locals.csrfToken = req.session.csrfToken;

  // Multipart routes parse the hidden token after the upload parser runs.
  // Those routes must apply this middleware again immediately after parsing.
  if (req.is('multipart/form-data')) {
    return next();
  }

  // Safe HTTP methods do not require CSRF validation
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Check token in body or headers
  const token = req.body?._csrf || req.headers['x-csrf-token'];

  if (!token || token !== req.session.csrfToken) {
    const error = new Error('Invalid or missing CSRF token. Please refresh the page and try again.');
    error.statusCode = 403;
    error.isCsrf = true;

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({ error: 'Forbidden', message: error.message });
    }

    return res.status(403).render('errors/403', {
      title: '403 - CSRF Validation Failed',
      reason: error.message,
      user: req.user || null,
      path: req.originalUrl,
    });
  }

  next();
}

module.exports = {
  csrfProtection,
};
