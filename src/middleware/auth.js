// src/middleware/auth.js

function authMiddleware(req, res, next) {
  req.user = req.session && req.session.user ? req.session.user : null;
  res.locals.currentUser = req.user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }
    return res.redirect(`/login?returnUrl=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

module.exports = {
  authMiddleware,
  requireAuth,
};
