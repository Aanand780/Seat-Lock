// src/db/pool.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let isInMemory = false;

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/seatlock';

function createPgMemPool() {
  const { newDb } = require('pg-mem');
  const db = newDb();

  // Load schema and seed into memory
  const schemaPath = path.join(__dirname, '../../db/schema.sql');
  const seedPath = path.join(__dirname, '../../db/seed.sql');

  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.public.none(schemaSql);
  }
  if (fs.existsSync(seedPath)) {
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    db.public.none(seedSql);
  }

  const pg = db.adapters.createPg();
  const memPool = new pg.Pool();
  isInMemory = true;
  console.log('[DB] Running with in-memory PostgreSQL emulator (pg-mem)');
  return memPool;
}

function getPool() {
  if (pool) return pool;

  // If FORCE_IN_MEMORY is set, skip TCP connection attempt
  if (process.env.FORCE_IN_MEMORY === 'true') {
    pool = createPgMemPool();
    return pool;
  }

  try {
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      max: 20,
    });
  } catch (err) {
    console.warn('[DB] Could not construct PG Pool, falling back to pg-mem:', err.message);
    pool = createPgMemPool();
  }

  return pool;
}

// Auto-run schema and seed against real Postgres if tables do not exist
async function initDb(activePool = getPool()) {
  if (isInMemory) return;

  try {
    const client = await activePool.connect();
    try {
      const checkRes = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = 'users'
        );
      `);

      if (!checkRes.rows[0].exists) {
        console.log('[DB] Tables not found. Initializing schema and seed...');
        const schemaPath = path.join(__dirname, '../../db/schema.sql');
        const seedPath = path.join(__dirname, '../../db/seed.sql');

        if (fs.existsSync(schemaPath)) {
          const schemaSql = fs.readFileSync(schemaPath, 'utf8');
          await client.query(schemaSql);
        }
        if (fs.existsSync(seedPath)) {
          const seedSql = fs.readFileSync(seedPath, 'utf8');
          await client.query(seedSql);
        }
        console.log('[DB] Schema and seed initialized successfully.');
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('[DB] Failed connecting to Postgres at ' + connectionString + ': ' + err.message);
    console.log('[DB] Switching to in-memory PostgreSQL fallback for seamless offline execution.');
    pool = createPgMemPool();
  }
}

// Wrapper object that always delegates to active pool instance
const poolProxy = {
  query: (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
  end: (...args) => getPool().end(...args),
  on: (...args) => getPool().on(...args),
};

module.exports = {
  pool: poolProxy,
  initDb,
  isInMemory: () => isInMemory,
  createPgMemPool,
};
