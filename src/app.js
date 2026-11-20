const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./config/db');

const { authContext } = require('./middleware/auth.middleware');
const { csrfProtection } = require('./middleware/csrf.middleware');
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');

const authRoutes = require('./routes/auth.routes');
const eventRoutes = require('./routes/event.routes');
const bookingRoutes = require('./routes/booking.routes');
const organizerRoutes = require('./routes/organizer.routes');
const auditRoutes = require('./routes/audit.routes');

const app = express();

// View Engine Setup (SSR with EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets if any
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Server-side session store using PostgreSQL
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'seatlock-session-secret-key-32chars-minimum',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 4, // 4 hours
    httpOnly: true,              // Prevent XSS access to session cookie
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',             // CSRF barrier for top-level navigations
  },
}));

// Global auth context (req.user & res.locals)
app.use(authContext);

// CSRF Protection on all mutating requests
app.use(csrfProtection);

// Routes Registration
app.use('/', authRoutes);
app.use('/', eventRoutes);
app.use('/', bookingRoutes);
app.use('/', organizerRoutes);
app.use('/', auditRoutes);

// Catch 404
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
