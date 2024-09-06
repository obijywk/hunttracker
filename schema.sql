DROP TABLE IF EXISTS sessions;

DROP TRIGGER IF EXISTS task_queue_add_trigger ON task_queue;
DROP FUNCTION IF EXISTS task_queue_add_notify;
DROP TABLE IF EXISTS task_queue;
DROP TYPE IF EXISTS task_type;

DROP VIEW IF EXISTS activity_latest_for_puzzle_and_user;
DROP INDEX IF EXISTS activity_puzzle_index;
DROP INDEX IF EXISTS activity_user_index;
DROP TABLE IF EXISTS activity CASCADE;
DROP TYPE IF EXISTS activity_type;

DROP TABLE IF EXISTS puzzle_tag CASCADE;
DROP TABLE IF EXISTS puzzle_user CASCADE;
DROP TABLE IF EXISTS puzzle_huddle_user CASCADE;

DROP TABLE IF EXISTS puzzles CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE puzzles (
  id text PRIMARY KEY,  -- Slack channel ID
  name text UNIQUE NOT NULL,
  url text,
  complete boolean,
  answer text,
  channel_name text,
  channel_topic text,
  channel_topic_modified_timestamp timestamp with time zone,
  sheet_url text,
  drawing_url text,
  calendar_event_id text,
  google_meet_url text,
  registration_timestamp timestamp with time zone,
  chat_modified_timestamp timestamp with time zone,
  sheet_modified_timestamp timestamp with time zone,
  drawing_modified_timestamp timestamp with time zone,
  manual_poke_timestamp timestamp with time zone,
  status_message_ts text,
  huddle_thread_message_ts text
);

CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name text UNIQUE NOT NULL
);

CREATE TABLE users (
  id text PRIMARY KEY,  -- Slack user ID
  name text,
  email text,
  admin boolean,
  google_people_resource_name text,  -- A person resourceName as returned by the Google People API
  google_activity_person_name text,  -- A knownUser personName as returned by the Google Drive Activity API
  google_email text  -- can be used if the user's Slack email is different than their Google account
);

CREATE TABLE puzzle_tag (
  puzzle_id text REFERENCES puzzles(id),
  tag_id SERIAL REFERENCES tags(id),
  applied timestamp,
  PRIMARY KEY (puzzle_id, tag_id)
);

CREATE TABLE puzzle_user (
  puzzle_id text REFERENCES puzzles(id),
  user_id text REFERENCES users(id),
  PRIMARY KEY (puzzle_id, user_id)
);

CREATE TABLE puzzle_huddle_user (
  puzzle_id text REFERENCES puzzles(id),
  user_id text REFERENCES users(id),
  PRIMARY KEY (puzzle_id, user_id)
);

CREATE TABLE puzzle_former_user (
  puzzle_id text REFERENCES puzzles(id),
  user_id text REFERENCES users(id),
  PRIMARY KEY (puzzle_id, user_id)
);

CREATE TYPE activity_type AS ENUM (
  'join_channel',
  'message_channel',
  'join_huddle',
  'edit_sheet',
  'record_answer'
);

CREATE TABLE activity (
  puzzle_id text REFERENCES puzzles(id),
  user_id text REFERENCES users(id),
  timestamp timestamp with time zone NOT NULL,
  activity_type activity_type NOT NULL,
  PRIMARY KEY (puzzle_id, user_id, timestamp)
);

CREATE INDEX activity_user_index ON activity (
  user_id,
  timestamp DESC
);

CREATE INDEX activity_puzzle_index ON activity (
  puzzle_id,
  timestamp DESC
);

CREATE VIEW activity_latest_for_puzzle_and_user AS
SELECT
  puzzle_id,
  user_id,
  MAX(timestamp) AS timestamp
FROM
  activity
GROUP BY
  puzzle_id,
  user_id
;

CREATE TYPE task_type AS ENUM (
  'create_puzzle',
  'edit_puzzle',
  'delete_puzzle',
  'refresh_puzzle',
  'publish_home',
  'refresh_users',
  'check_sheet_editors',
  'sync_google_people'
);

CREATE TABLE task_queue (
  id SERIAL PRIMARY KEY,
  task_type task_type,
  payload jsonb,
  error json
);

CREATE FUNCTION task_queue_add_notify() RETURNS TRIGGER AS $$
  BEGIN
    PERFORM pg_notify('task_queue_add', NULL);
    RETURN NULL;
  END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_queue_add_trigger
AFTER INSERT ON task_queue
EXECUTE PROCEDURE task_queue_add_notify();

CREATE TABLE sessions (
  sid varchar NOT NULL,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
) WITH (OIDS=FALSE);
ALTER TABLE sessions ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;