/**
 * Central Express error handler.
 * Renders user-friendly SSR error pages and maps database conflict/timeout codes.
 */
function errorHandler(err, req, res, next) {
  console.error('[Error Handler]', err);
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'An unexpected internal server error occurred.';

  // Map PostgreSQL 55P03 (lock_not_available) to HTTP 503
  if (err.code === '55P03') {
    statusCode = 503;
    message = 'High booking traffic detected. The seat lock could not be acquired within 2 seconds. Please retry.';
  }

  // Map PostgreSQL 40001 (serialization_failure) or 23505 (unique_violation) to HTTP 409
  if (err.code === '40001' || err.code === '23505') {
    statusCode = 409;
    message = 'A concurrency conflict occurred. One or more of the selected seats were already reserved.';
  }

  res.status(statusCode);

  // Return JSON if API client
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({
      error: getErrorTitle(statusCode),
      message,
      statusCode,
    });
  }

  // Map to corresponding view
  const viewMap = {
    403: 'errors/403',
    404: 'errors/404',
    409: 'errors/409',
    503: 'errors/503',
  };

  const view = viewMap[statusCode] || 'errors/500';

  return res.render(view, {
    title: `${statusCode} - ${getErrorTitle(statusCode)}`,
    reason: message,
    message,
    user: req.user || null,
    path: req.originalUrl,
  });
}

function getErrorTitle(code) {
  switch (code) {
    case 403: return 'Access Denied';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 503: return 'Service Temporarily Unavailable';
    default: return 'Internal Server Error';
  }
}

/**
 * 404 Handler for unmatched routes
 */
function notFoundHandler(req, res, next) {
  res.status(404);
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({ error: 'Not Found', message: 'Resource not found', statusCode: 404 });
  }
  res.render('errors/404', {
    title: '404 - Not Found',
    message: 'The page you requested does not exist.',
    user: req.user || null,
    path: req.originalUrl,
  });
}

module.exports = {
  errorHandler,
  notFoundHandler,
};
