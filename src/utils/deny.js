const { writeAudit } = require('../services/audit.service');

/**
 * Centralized deny() helper for all permission and authorization rejections.
 * Writes an ACCESS_DENIED audit log record and responds with HTTP 403.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {string} reason - Human-readable explanation of rejection
 * @param {object} [extraDetails={}] - Additional metadata for audit log
 */
async function deny(req, res, reason = 'Access denied', extraDetails = {}) {
  const currentUser = req.user || null;
  const eventId = req.params?.eventId || req.params?.id || req.body?.eventId || null;
  const parsedEventId = eventId && !isNaN(parseInt(eventId, 10)) ? parseInt(eventId, 10) : null;

  try {
    await writeAudit(currentUser, {
      actorId: currentUser ? currentUser.id : null,
      actorRole: currentUser ? currentUser.role : 'ANONYMOUS',
      action: 'ACCESS_DENIED',
      eventId: parsedEventId,
      details: {
        reason,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        ...extraDetails,
      },
    });
  } catch (auditErr) {
    console.error('Failed to write ACCESS_DENIED audit log:', auditErr);
  }

  res.status(403);

  // Return JSON if client requested JSON or is an AJAX/API call
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({
      error: 'Forbidden',
      message: reason,
      statusCode: 403,
    });
  }

  // Otherwise render server-rendered SSR error page
  return res.render('errors/403', {
    title: '403 - Access Denied',
    reason,
    user: req.user || null,
    path: req.originalUrl,
  });
}

module.exports = {
  deny,
};
