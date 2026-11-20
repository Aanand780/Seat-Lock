ALTER TABLE events ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ;
UPDATE events SET end_time = start_time + INTERVAL '3 hours' WHERE end_time IS NULL;

CREATE OR REPLACE FUNCTION set_event_end_time_default() RETURNS trigger AS $$
BEGIN
  IF NEW.end_time IS NULL THEN
    NEW.end_time := NEW.start_time + INTERVAL '3 hours';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_set_end_time ON events;
CREATE TRIGGER events_set_end_time BEFORE INSERT OR UPDATE OF start_time ON events
FOR EACH ROW EXECUTE FUNCTION set_event_end_time_default();
