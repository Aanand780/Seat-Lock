require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/db');
const { deleteExpiredEvents } = require('./services/event.service');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`SeatLock Platform running on http://localhost:${PORT}`);
  console.log(`Connected to Postgres DB on port ${process.env.PGPORT || 5432}`);
  console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`=======================================================`);
  deleteExpiredEvents().catch((err) => console.error('Expired event cleanup failed:', err));
});
const eventCleanupTimer = setInterval(() => {
  deleteExpiredEvents().catch((err) => console.error('Expired event cleanup failed:', err));
}, 60 * 1000);

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  clearInterval(eventCleanupTimer);
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await pool.end();
      console.log('PostgreSQL connection pool closed.');
    } catch (err) {
      console.error('Error closing DB pool:', err);
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
