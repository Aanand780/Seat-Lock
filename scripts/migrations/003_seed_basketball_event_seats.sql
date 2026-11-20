-- Add selectable seats to the published basketball seed event.
-- Safe to run more than once because event seats have a unique constraint.
INSERT INTO seats (event_id, row_label, seat_number, status)
SELECT e.id, rows.row_label, seat_numbers.seat_number, 'AVAILABLE'
FROM events e
CROSS JOIN (VALUES ('A'), ('B'), ('C')) AS rows(row_label)
CROSS JOIN generate_series(1, 10) AS seat_numbers(seat_number)
WHERE e.title = 'Inter-College Basketball Championship Final'
ON CONFLICT (event_id, row_label, seat_number) DO NOTHING;
