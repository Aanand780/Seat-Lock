// src/middleware/session.js

const session = require('express-session');

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'seatlock-super-secret-key-32chars-min-local',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

module.exports = sessionMiddleware;
