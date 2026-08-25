CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_org TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;

CREATE TABLE triage_runs (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'succeeded', 'needs_review', 'failed')
  ),
  input_quality TEXT NOT NULL CHECK (
    input_quality IN ('valid', 'low_signal', 'malformed')
  ),
  review_reasons TEXT NOT NULL CHECK (
    json_valid(review_reasons) AND json_type(review_reasons) = 'array'
  ),
  summary TEXT,
  -- Category validity lives in the shared taxonomy/Zod boundary. Keeping this
  -- as text lets the taxonomy grow without a database migration.
  category TEXT,
  priority TEXT CHECK (
    priority IS NULL OR priority IN ('high', 'medium', 'low')
  ),
  suggested_next_action TEXT,
  provider TEXT NOT NULL CHECK (
    provider IN ('anthropic', 'openai', 'bedrock')
  ),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (
      status = 'processing'
      AND completed_at IS NULL
      AND summary IS NULL
      AND category IS NULL
      AND priority IS NULL
      AND suggested_next_action IS NULL
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR
    (
      status IN ('succeeded', 'needs_review')
      AND completed_at IS NOT NULL
      AND summary IS NOT NULL
      AND category IS NOT NULL
      AND priority IS NOT NULL
      AND suggested_next_action IS NOT NULL
      AND error_code IS NULL
      AND error_message IS NULL
    )
    OR
    (
      status = 'failed'
      AND completed_at IS NOT NULL
      AND summary IS NULL
      AND category IS NULL
      AND priority IS NULL
      AND suggested_next_action IS NULL
      AND error_code IS NOT NULL
      AND error_message IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX idx_triage_runs_message_created
ON triage_runs(message_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_triage_runs_one_processing_per_message
ON triage_runs(message_id)
WHERE status = 'processing';

CREATE TRIGGER messages_prevent_update
BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'seeded messages are immutable');
END;

CREATE TRIGGER messages_prevent_delete
BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'seeded messages are immutable');
END;

CREATE TRIGGER triage_runs_prevent_terminal_update
BEFORE UPDATE ON triage_runs
WHEN OLD.status <> 'processing'
BEGIN
  SELECT RAISE(ABORT, 'completed triage runs are immutable');
END;

CREATE TRIGGER triage_runs_preserve_identity
BEFORE UPDATE ON triage_runs
WHEN
  NEW.message_id <> OLD.message_id
  OR NEW.input_quality <> OLD.input_quality
  OR NEW.review_reasons <> OLD.review_reasons
  OR NEW.provider <> OLD.provider
  OR NEW.model <> OLD.model
  OR NEW.prompt_version <> OLD.prompt_version
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'triage run identity is immutable');
END;

CREATE TRIGGER triage_runs_prevent_delete
BEFORE DELETE ON triage_runs
BEGIN
  SELECT RAISE(ABORT, 'triage run history is append-only');
END;
