ALTER TABLE triage_runs ADD COLUMN resolved_model TEXT;

CREATE TRIGGER triage_runs_require_resolved_model_on_success
BEFORE UPDATE OF status ON triage_runs
WHEN
  NEW.status IN ('succeeded', 'needs_review')
  AND (NEW.resolved_model IS NULL OR trim(NEW.resolved_model) = '')
BEGIN
  SELECT RAISE(ABORT, 'successful triage runs require a resolved model');
END;
