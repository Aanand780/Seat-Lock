const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../services/user.service');

// GET /login
router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/events');
  }
  const nextUrl = req.query.next || '';
  res.render('auth/login', {
    title: 'Login - SeatLock',
    error: null,
    email: '',
    nextUrl,
  });
});

// POST /login
router.post('/login', async (req, res, next) => {
  const { email, password, next: nextUrl } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';

  try {
    const user = await authenticateUser(email, password, { ip, userAgent });

    // Regenerate session upon successful login to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = user;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);

        if (nextUrl && nextUrl.startsWith('/') && !nextUrl.startsWith('//')) {
          return res.redirect(nextUrl);
        }
        return res.redirect('/events');
      });
    });
  } catch (authErr) {
    return res.status(authErr.statusCode || 401).render('auth/login', {
      title: 'Login - SeatLock',
      error: authErr.message,
      email: email || '',
      nextUrl: nextUrl || '',
    });
  }
});

// POST /logout
router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;
