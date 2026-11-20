-- Seed Users
-- Password for all seeded users is: Password123!
-- Bcrypt hash generated with 10 salt rounds:
INSERT INTO users (name, email, password_hash, role)
VALUES 
  ('Admin User', 'admin@collegefest.edu', '$2a$10$5wt6SYsymaKVEibyMuhKmeq8rA9eOvpp8d2Lf/CEAl0HzMAW2FbOK', 'ADMIN'),
  ('Cultural Organizer', 'organizer@collegefest.edu', '$2a$10$5wt6SYsymaKVEibyMuhKmeq8rA9eOvpp8d2Lf/CEAl0HzMAW2FbOK', 'ORGANIZER'),
  ('Sports Organizer', 'sports@collegefest.edu', '$2a$10$5wt6SYsymaKVEibyMuhKmeq8rA9eOvpp8d2Lf/CEAl0HzMAW2FbOK', 'ORGANIZER'),
  ('Aanand Student', 'student@collegefest.edu', '$2a$10$5wt6SYsymaKVEibyMuhKmeq8rA9eOvpp8d2Lf/CEAl0HzMAW2FbOK', 'STUDENT'),
  ('Priya Student', 'priya@collegefest.edu', '$2a$10$5wt6SYsymaKVEibyMuhKmeq8rA9eOvpp8d2Lf/CEAl0HzMAW2FbOK', 'STUDENT')
ON CONFLICT (email) DO NOTHING;

-- Seed Events
INSERT INTO events (id, title, description, venue, start_time, is_published, organizer_id, version)
VALUES 
  (1, 'Battle of the Bands - Rock Night 2026', 'The headline musical spectacle featuring top university bands and guest stars.', 'Main Auditorium', NOW() + INTERVAL '7 days', true, 2, 1),
  (2, 'EDM Night DJ Arena (Draft)', 'High-energy EDM and light show. Not yet open to students.', 'Open Air Amphitheatre', NOW() + INTERVAL '10 days', false, 2, 1),
  (3, 'Inter-College Basketball Championship Final', 'Championship finals between defending champions and rivals.', 'Indoor Sports Complex', NOW() + INTERVAL '5 days', true, 3, 1)
ON CONFLICT (id) DO NOTHING;

SELECT setval('events_id_seq', (SELECT MAX(id) FROM events));

-- Seed Seats for Event 1 (Rows A, B, C; 10 seats each = 30 seats)
DO $$
DECLARE
    r TEXT;
    n INT;
BEGIN
    FOR r IN SELECT unnest(ARRAY['A', 'B', 'C']) LOOP
        FOR n IN 1..10 LOOP
            INSERT INTO seats (event_id, row_label, seat_number, status)
            VALUES (1, r, n, 'AVAILABLE')
            ON CONFLICT (event_id, row_label, seat_number) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

-- Seed Seats for Event 3 (Rows A, B, C; 10 seats each = 30 seats)
DO $$
DECLARE
    r TEXT;
    n INT;
BEGIN
    FOR r IN SELECT unnest(ARRAY['A', 'B', 'C']) LOOP
        FOR n IN 1..10 LOOP
            INSERT INTO seats (event_id, row_label, seat_number, status)
            VALUES (3, r, n, 'AVAILABLE')
            ON CONFLICT (event_id, row_label, seat_number) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;
