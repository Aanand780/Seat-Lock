-- Seed data for SeatLock

-- 1. Seed Users
-- Passwords:
-- admin@collegefest.org -> admin123
-- organizer@collegefest.org -> organizer123
-- organizer2@collegefest.org -> organizer123
-- student1@collegefest.org -> student123
-- student2@collegefest.org -> student123
-- student3@collegefest.org -> student123

INSERT INTO users (id, name, email, password_hash, role, created_at)
VALUES
    ('u-admin-1', 'Fest Administrator', 'admin@collegefest.org', '$2a$10$cABLvU.3jt3IBKl7K20ofO4xjtkxZkO5foH3aoOQqAgCgAXFqxBaO', 'admin', now()),
    ('u-org-1', 'Elena Vance (Lead Organizer)', 'organizer@collegefest.org', '$2a$10$4PKKTi.eHnQFyaMOtEs3bOtm2W/lVc9K7Y5SxkJRsKfWUrgQAa.x2', 'organizer', now()),
    ('u-org-2', 'Marcus Brody (Tech Events)', 'organizer2@collegefest.org', '$2a$10$4PKKTi.eHnQFyaMOtEs3bOtm2W/lVc9K7Y5SxkJRsKfWUrgQAa.x2', 'organizer', now()),
    ('u-stu-1', 'Alex Mercer (Student)', 'student1@collegefest.org', '$2a$10$m8.FtlgzZmvzL30C38ss6Ol0fh10TDpdoziBwO3AWUeLsxGUGVbXu', 'student', now()),
    ('u-stu-2', 'Beatriz Silva (Student)', 'student2@collegefest.org', '$2a$10$m8.FtlgzZmvzL30C38ss6Ol0fh10TDpdoziBwO3AWUeLsxGUGVbXu', 'student', now()),
    ('u-stu-3', 'Chen Wei (Student)', 'student3@collegefest.org', '$2a$10$m8.FtlgzZmvzL30C38ss6Ol0fh10TDpdoziBwO3AWUeLsxGUGVbXu', 'student', now())
ON CONFLICT (id) DO NOTHING;

-- 2. Seed Events
INSERT INTO events (id, title, description, venue, start_time, end_time, status, organizer_id, version, created_at, updated_at)
VALUES
    (
        'e-headline-2026',
        'Grand Pro Night 2026 - Live Concert',
        'The headline musical concert of the annual college fest featuring top guest artists and bands.',
        'Grand Auditorium - Main Stage',
        now() + INTERVAL '7 days',
        now() + INTERVAL '7 days 4 hours',
        'published',
        'u-org-1',
        1,
        now(),
        now()
    ),
    (
        'e-hackathon-2026',
        'Inter-College Hackathon Finals',
        '24-hour non-stop building challenge with live demo and judging.',
        'Innovation Hub - Hall B',
        now() + INTERVAL '14 days',
        now() + INTERVAL '15 days',
        'published',
        'u-org-2',
        1,
        now(),
        now()
    ),
    (
        'e-past-2026',
        'Freshers Welcome Bash (Concluded)',
        'Welcome celebration for incoming freshman batch.',
        'Open Air Theatre',
        now() - INTERVAL '1 day',
        now() - INTERVAL '20 hours',
        'published',
        'u-org-1',
        1,
        now(),
        now()
    ),
    (
        'e-draft-2026',
        'Cultural Drama Prep & Rehearsal',
        'Closed technical rehearsal for backstage crew and cast.',
        'Mini Theatre',
        now() + INTERVAL '3 days',
        now() + INTERVAL '3 days 3 hours',
        'draft',
        'u-org-1',
        1,
        now(),
        now()
    )
ON CONFLICT (id) DO NOTHING;

-- 3. Seed Seats for Headline Event ('e-headline-2026')
-- Grid of 50 seats: Rows A, B, C, D, E with columns 1 to 10
INSERT INTO seats (id, event_id, seat_number, row_name, seat_col, is_blocked, created_at)
VALUES
    ('s-A01', 'e-headline-2026', 'A1', 'A', 1, false, now()),
    ('s-A02', 'e-headline-2026', 'A2', 'A', 2, false, now()),
    ('s-A03', 'e-headline-2026', 'A3', 'A', 3, false, now()),
    ('s-A04', 'e-headline-2026', 'A4', 'A', 4, false, now()),
    ('s-A05', 'e-headline-2026', 'A5', 'A', 5, false, now()),
    ('s-A06', 'e-headline-2026', 'A6', 'A', 6, false, now()),
    ('s-A07', 'e-headline-2026', 'A7', 'A', 7, false, now()),
    ('s-A08', 'e-headline-2026', 'A8', 'A', 8, false, now()),
    ('s-A09', 'e-headline-2026', 'A9', 'A', 9, false, now()),
    ('s-A10', 'e-headline-2026', 'A10', 'A', 10, false, now()),

    ('s-B01', 'e-headline-2026', 'B1', 'B', 1, false, now()),
    ('s-B02', 'e-headline-2026', 'B2', 'B', 2, false, now()),
    ('s-B03', 'e-headline-2026', 'B3', 'B', 3, false, now()),
    ('s-B04', 'e-headline-2026', 'B4', 'B', 4, false, now()),
    ('s-B05', 'e-headline-2026', 'B5', 'B', 5, false, now()),
    ('s-B06', 'e-headline-2026', 'B6', 'B', 6, false, now()),
    ('s-B07', 'e-headline-2026', 'B7', 'B', 7, false, now()),
    ('s-B08', 'e-headline-2026', 'B8', 'B', 8, false, now()),
    ('s-B09', 'e-headline-2026', 'B9', 'B', 9, false, now()),
    ('s-B10', 'e-headline-2026', 'B10', 'B', 10, false, now()),

    ('s-C01', 'e-headline-2026', 'C1', 'C', 1, false, now()),
    ('s-C02', 'e-headline-2026', 'C2', 'C', 2, false, now()),
    ('s-C03', 'e-headline-2026', 'C3', 'C', 3, false, now()),
    ('s-C04', 'e-headline-2026', 'C4', 'C', 4, false, now()),
    ('s-C05', 'e-headline-2026', 'C5', 'C', 5, false, now()),
    ('s-C06', 'e-headline-2026', 'C6', 'C', 6, false, now()),
    ('s-C07', 'e-headline-2026', 'C7', 'C', 7, false, now()),
    ('s-C08', 'e-headline-2026', 'C8', 'C', 8, false, now()),
    ('s-C09', 'e-headline-2026', 'C9', 'C', 9, false, now()),
    ('s-C10', 'e-headline-2026', 'C10', 'C', 10, false, now()),

    ('s-D01', 'e-headline-2026', 'D1', 'D', 1, false, now()),
    ('s-D02', 'e-headline-2026', 'D2', 'D', 2, false, now()),
    ('s-D03', 'e-headline-2026', 'D3', 'D', 3, false, now()),
    ('s-D04', 'e-headline-2026', 'D4', 'D', 4, false, now()),
    ('s-D05', 'e-headline-2026', 'D5', 'D', 5, false, now()),
    ('s-D06', 'e-headline-2026', 'D6', 'D', 6, false, now()),
    ('s-D07', 'e-headline-2026', 'D7', 'D', 7, false, now()),
    ('s-D08', 'e-headline-2026', 'D8', 'D', 8, false, now()),
    ('s-D09', 'e-headline-2026', 'D9', 'D', 9, false, now()),
    ('s-D10', 'e-headline-2026', 'D10', 'D', 10, false, now()),

    ('s-E01', 'e-headline-2026', 'E1', 'E', 1, false, now()),
    ('s-E02', 'e-headline-2026', 'E2', 'E', 2, false, now()),
    ('s-E03', 'e-headline-2026', 'E3', 'E', 3, false, now()),
    ('s-E04', 'e-headline-2026', 'E4', 'E', 4, false, now()),
    ('s-E05', 'e-headline-2026', 'E5', 'E', 5, false, now()),
    ('s-E06', 'e-headline-2026', 'E6', 'E', 6, false, now()),
    ('s-E07', 'e-headline-2026', 'E7', 'E', 7, false, now()),
    ('s-E08', 'e-headline-2026', 'E8', 'E', 8, false, now()),
    ('s-E09', 'e-headline-2026', 'E9', 'E', 9, true, now()),   -- Blocked for sound mixer
    ('s-E10', 'e-headline-2026', 'E10', 'E', 10, true, now())  -- Blocked for VIP security
ON CONFLICT (id) DO NOTHING;

-- 4. Seed Seats for Hackathon ('e-hackathon-2026')
INSERT INTO seats (id, event_id, seat_number, row_name, seat_col, is_blocked, created_at)
VALUES
    ('s-H-A1', 'e-hackathon-2026', 'A1', 'A', 1, false, now()),
    ('s-H-A2', 'e-hackathon-2026', 'A2', 'A', 2, false, now()),
    ('s-H-A3', 'e-hackathon-2026', 'A3', 'A', 3, false, now()),
    ('s-H-A4', 'e-hackathon-2026', 'A4', 'A', 4, false, now()),
    ('s-H-B1', 'e-hackathon-2026', 'B1', 'B', 1, false, now()),
    ('s-H-B2', 'e-hackathon-2026', 'B2', 'B', 2, false, now()),
    ('s-H-B3', 'e-hackathon-2026', 'B3', 'B', 3, false, now()),
    ('s-H-B4', 'e-hackathon-2026', 'B4', 'B', 4, false, now())
ON CONFLICT (id) DO NOTHING;
