DROP TRIGGER IF EXISTS task_queue_add_trigger ON task_queue;
DROP FUNCTION IF EXISTS task_queue_add_notify;
DROP TABLE IF EXISTS task_queue;
DROP TYPE IF EXISTS task_type;

DROP TABLE IF EXISTS puzzle_tag;
DROP TABLE IF EXISTS solve_user;

DROP TABLE IF EXISTS solves;

DROP TABLE IF EXISTS puzzles;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS users;

CREATE TABLE puzzles (
  id SERIAL PRIMARY KEY,
  name text,
  url text,
  solved boolean DEFAULT FALSE,
  answer text
);

CREATE TABLE solves (
  id text PRIMARY KEY,  -- Slack channel ID
  puzzle_id SERIAL REFERENCES puzzles(id),
  instance_name text,
  channel_name text,
  channel_topic text,
  sheet_url text,
  chat_modified_timestamp timestamp,
  sheet_modified_timestamp timestamp,
  manual_poke_timestamp timestamp,
  status_message_ts text
);

CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  tag text
);

CREATE TABLE users (
  id text PRIMARY KEY,  -- Slack user ID
  name text
);

CREATE TABLE puzzle_tag (
  puzzle_id SERIAL REFERENCES puzzles(id),
  tag_id SERIAL REFERENCES tags(id),
  PRIMARY KEY (puzzle_id, tag_id)
);

CREATE TABLE solve_user (
  solve_id text REFERENCES solves(id),
  user_id text REFERENCES users(id),
  PRIMARY KEY (solve_id, user_id)
);

CREATE TYPE task_type AS ENUM (
  'create_solve',
  'refresh_solve'
);

CREATE TABLE task_queue (
  id SERIAL PRIMARY KEY,
  task_type task_type,
  payload jsonb
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