// src/middleware/rbac.js

const { ForbiddenError } = require('../services/auditService');

/**
 * Route-level role enforcement middleware.
 * Usage: requireRole('admin') or requireRole('organizer', 'admin')
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      return res.redirect(`/login?returnUrl=${encodeURIComponent(req.originalUrl)}`);
    }

    if (!allowedRoles.includes(req.user.role)) {
      const err = new ForbiddenError(
        `Access denied. Requires one of the following roles: [${allowedRoles.join(', ')}]. Your role: ${req.user.role}`
      );
      return next(err);
    }

    next();
  };
}

module.exports = {
  requireRole,
};
