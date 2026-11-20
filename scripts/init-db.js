require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'seatlock',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Connecting to PostgreSQL database...');
    console.log(`Connected to ${process.env.PGDATABASE || 'postgres'} at ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`);

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    console.log('Applying schema...');
    await client.query(schemaSql);
    console.log('Schema applied successfully.');

    // Seed users with bcrypt
    const password = 'Password123!';
    const passwordHash = await bcrypt.hash(password, 10);

    console.log('Seeding initial users...');
    const users = [
      { name: 'Admin User', email: 'admin@collegefest.edu', role: 'ADMIN' },
      { name: 'Cultural Organizer', email: 'organizer@collegefest.edu', role: 'ORGANIZER' },
      { name: 'Sports Organizer', email: 'sports@collegefest.edu', role: 'ORGANIZER' },
      { name: 'Aanand Student', email: 'student@collegefest.edu', role: 'STUDENT' },
      { name: 'Priya Student', email: 'priya@collegefest.edu', role: 'STUDENT' },
      { name: 'Rohan Student', email: 'rohan@collegefest.edu', role: 'STUDENT' },
      { name: 'Sneha Student', email: 'sneha@collegefest.edu', role: 'STUDENT' }
    ];

    for (const u of users) {
      await client.query(`
        INSERT INTO users (name, email, password_hash, role)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;
      `, [u.name, u.email, passwordHash, u.role]);
    }

    // Get Organizer 1 ID
    const orgRes = await client.query(`SELECT id FROM users WHERE email = 'organizer@collegefest.edu'`);
    const orgId = orgRes.rows[0].id;

    // Get Organizer 2 ID
    const org2Res = await client.query(`SELECT id FROM users WHERE email = 'sports@collegefest.edu'`);
    const org2Id = org2Res.rows[0].id;

    console.log('Seeding events...');
    // Event 1: Published future headline show (Rock Night)
    const ev1Res = await client.query(`
      INSERT INTO events (title, description, venue, start_time, is_published, organizer_id, version)
      VALUES ($1, $2, $3, $4, $5, $6, 1)
      ON CONFLICT DO NOTHING
      RETURNING id;
    `, [
      'Battle of the Bands - Rock Night 2026',
      'The headline musical spectacle featuring top university bands and guest stars.',
      'Main Auditorium',
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days in future
      true,
      orgId
    ]);

    let ev1Id = ev1Res.rows[0]?.id;
    if (!ev1Id) {
      const existing = await client.query(`SELECT id FROM events WHERE title = 'Battle of the Bands - Rock Night 2026'`);
      ev1Id = existing.rows[0].id;
    }

    // Event 2: Draft / Unpublished Event
    const ev2Res = await client.query(`
      INSERT INTO events (title, description, venue, start_time, is_published, organizer_id, version)
      VALUES ($1, $2, $3, $4, $5, $6, 1)
      ON CONFLICT DO NOTHING
      RETURNING id;
    `, [
      'EDM Night DJ Arena (Draft)',
      'High-energy EDM and light show. Not yet open to students.',
      'Open Air Amphitheatre',
      new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      false, // unpublished draft!
      orgId
    ]);

    // Event 3: Published Sports Fest Event by Sports Organizer
    const ev3Res = await client.query(`
      INSERT INTO events (title, description, venue, start_time, is_published, organizer_id, version)
      VALUES ($1, $2, $3, $4, $5, $6, 1)
      ON CONFLICT DO NOTHING
      RETURNING id;
    `, [
      'Inter-College Basketball Championship Final',
      'Championship finals between defending champions and rivals.',
      'Indoor Sports Complex',
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      true,
      org2Id
    ]);

    // Seed Seats for Event 1 (Rows A, B, C; 10 seats each = 30 seats)
    console.log('Seeding seats for headline event...');
    const rows = ['A', 'B', 'C'];
    for (const row of rows) {
      for (let num = 1; num <= 10; num++) {
        await client.query(`
          INSERT INTO seats (event_id, row_label, seat_number, status)
          VALUES ($1, $2, $3, 'AVAILABLE')
          ON CONFLICT (event_id, row_label, seat_number) DO NOTHING;
        `, [ev1Id, row, num]);
      }
    }

    console.log('Database initialized and seeded successfully!');
    console.log('\nDefault Test Accounts:');
    console.log('  Admin:     admin@collegefest.edu     / Password123!');
    console.log('  Organizer: organizer@collegefest.edu / Password123!');
    console.log('  Organizer2: sports@collegefest.edu   / Password123!');
    console.log('  Student:   student@collegefest.edu   / Password123!');
    console.log('  Student2:  priya@collegefest.edu     / Password123!');
  } catch (err) {
    console.error('Database initialization error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
