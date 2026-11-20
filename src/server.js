// src/server.js

require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const sessionMiddleware = require('./middleware/session');
const { authMiddleware } = require('./middleware/auth');
const csrfMiddleware = require('./middleware/csrf');
const errorHandler = require('./middleware/errors');

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const bookingRoutes = require('./routes/bookings');
const organizerRoutes = require('./routes/organizer');
const adminRoutes = require('./routes/admin');

const { initDb, pool } = require('./db/pool');
const { startSweeper, stopSweeper } = require('./jobs/holdExpirySweeper');

const app = express();
const PORT = process.env.PORT || 3000;

// Set up view engine (SSR with EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Core middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(authMiddleware);
app.use(csrfMiddleware);

// Mount routes
app.use(authRoutes);
app.use(eventRoutes);
app.use(bookingRoutes);
app.use(organizerRoutes);
app.use(adminRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).render('404', { title: '404 - Not Found' });
});

// Central error handler
app.use(errorHandler);

let server = null;

async function bootstrap() {
  try {
    // Check and initialize schema if needed
    await initDb();

    // Start background hold-expiry sweeper (runs every 30s)
    startSweeper(30000);

    server = app.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 SeatLock Server listening on http://localhost:${PORT}`);
      console.log(`🔒 Locking: Row-level SELECT ... FOR UPDATE (timeout=2s)`);
      console.log(`📊 Sharding: 4 shards (audit_logs_0..3) with FNV-1a`);
      console.log(`======================================================\n`);
    });
  } catch (err) {
    console.error('[Bootstrap Error]', err);
    process.exit(1);
  }
}

// Graceful shutdown
function gracefulShutdown() {
  console.log('\n[Shutdown] Closing SeatLock server...');
  stopSweeper();
  if (server) {
    server.close(async () => {
      try {
        await pool.end();
      } catch (_) {}
      console.log('[Shutdown] Server closed gracefully.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

if (require.main === module) {
  bootstrap();
}

module.exports = { app, bootstrap, server };
