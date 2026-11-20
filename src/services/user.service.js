const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { writeAudit } = require('./audit.service');

/**
 * Authenticate user with email and password.
 * Writes LOGIN or LOGIN_FAILED audit records.
 *
 * @param {string} email
 * @param {string} password
 * @param {object} meta - { ip, userAgent }
 * @returns {Promise<object>} Authenticated user object
 */
async function authenticateUser(email, password, meta = {}) {
  const normalizedEmail = (email || '').trim().toLowerCase();

  const result = await db.query(
    'SELECT id, name, email, password_hash, role FROM users WHERE LOWER(email) = $1',
    [normalizedEmail]
  );

  const user = result.rows[0];

  if (!user) {
    await writeAudit(null, {
      actorId: null,
      actorRole: 'ANONYMOUS',
      action: 'LOGIN_FAILED',
      eventId: null,
      details: { email: normalizedEmail, reason: 'User not found', ...meta },
    });
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    await writeAudit(user, {
      actorId: user.id,
      actorRole: user.role,
      action: 'LOGIN_FAILED',
      eventId: null,
      details: { email: normalizedEmail, reason: 'Incorrect password', ...meta },
    });
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  // Record successful login audit
  await writeAudit(user, {
    actorId: user.id,
    actorRole: user.role,
    action: 'LOGIN',
    eventId: null,
    details: { email: user.email, ...meta },
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

/**
 * Get user by ID
 */
async function getUserById(id) {
  const result = await db.query(
    'SELECT id, name, email, role, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

module.exports = {
  authenticateUser,
  getUserById,
};
