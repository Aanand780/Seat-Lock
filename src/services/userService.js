// src/services/userService.js

const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { writeAudit, ForbiddenError } = require('./auditService');

/**
 * Authenticates user and logs LOGIN or LOGIN_FAILED audit events.
 */
async function authenticate(email, password) {
  if (!email || !password) {
    await writeAudit({
      actorId: 'anonymous',
      action: 'LOGIN_FAILED',
      details: { email: email || '', reason: 'missing_credentials' }
    });
    return null;
  }

  const result = await pool.query(
    'SELECT id, name, email, password_hash, role FROM users WHERE LOWER(email) = LOWER($1)',
    [email.trim()]
  );

  if (result.rows.length === 0) {
    await writeAudit({
      actorId: 'anonymous',
      action: 'LOGIN_FAILED',
      details: { email: email.trim(), reason: 'user_not_found' }
    });
    return null;
  }

  const user = result.rows[0];
  const isMatch = await bcrypt.compare(password, user.password_hash);

  if (!isMatch) {
    await writeAudit({
      actorId: user.id,
      action: 'LOGIN_FAILED',
      details: { email: user.email, reason: 'invalid_password' }
    });
    return null;
  }

  // Successful login
  await writeAudit({
    actorId: user.id,
    action: 'LOGIN',
    details: { email: user.email, role: user.role }
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, name, email, role, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

async function listUsers(currentUser) {
  if (!currentUser || currentUser.role !== 'admin') {
    throw new ForbiddenError('Only administrators may manage users.');
  }

  const result = await pool.query(
    'SELECT id, name, email, role, created_at FROM users ORDER BY created_at ASC'
  );
  return result.rows;
}

async function updateUserRole(currentUser, targetUserId, newRole) {
  if (!currentUser || currentUser.role !== 'admin') {
    throw new ForbiddenError('Only administrators may modify roles.');
  }

  const allowedRoles = ['admin', 'organizer', 'student'];
  if (!allowedRoles.includes(newRole)) {
    throw new Error('Invalid role specified.');
  }

  const result = await pool.query(
    'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role',
    [newRole, targetUserId]
  );

  return result.rows[0] || null;
}

module.exports = {
  authenticate,
  getUserById,
  listUsers,
  updateUserRole,
};
