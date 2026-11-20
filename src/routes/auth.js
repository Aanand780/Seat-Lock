// src/routes/auth.js

const express = require('express');
const router = express.Router();
const userService = require('../services/userService');

router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/events');
  }
  res.render('login', {
    title: 'Login - SeatLock',
    error: req.query.error || null,
    returnUrl: req.query.returnUrl || '/events',
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password, returnUrl } = req.body;
    const user = await userService.authenticate(email, password);

    if (!user) {
      return res.render('login', {
        title: 'Login - SeatLock',
        error: 'Invalid email or password.',
        returnUrl: returnUrl || '/events',
      });
    }

    // Regenerate session on login for session fixation protection
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = user;
      res.redirect(returnUrl || '/events');
    });
  } catch (err) {
    next(err);
  }
});

router.get('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

router.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

router.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.session?.csrfToken || '' });
});

module.exports = router;
