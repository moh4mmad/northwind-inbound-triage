DROP INDEX idx_triage_runs_message_created;

CREATE INDEX idx_triage_runs_message_id
ON triage_runs(message_id, id DESC);
