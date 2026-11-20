/**
 * Authentication context middleware.
 * Attaches user from session to req and res.locals for template rendering.
 */
function authContext(req, res, next) {
  const user = req.session?.user || null;
  req.user = user;
  res.locals.user = user;
  res.locals.isAdmin = user?.role === 'ADMIN';
  res.locals.isOrganizer = user?.role === 'ORGANIZER';
  res.locals.isStudent = user?.role === 'STUDENT';
  next();
}

module.exports = {
  authContext,
};
