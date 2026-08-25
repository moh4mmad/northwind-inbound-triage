import type { AppDatabase } from "./types";
import { assertStaleThreshold, toIsoTimestamp } from "./time";

const INTERRUPTED_ERROR_CODE = "PROCESS_INTERRUPTED";
const INTERRUPTED_ERROR_MESSAGE =
  "Analysis was interrupted before it completed. Please retry.";

export function recoverStaleProcessingRows(
  database: AppDatabase,
  olderThanMs: number,
  now: Date,
): number {
  const threshold = assertStaleThreshold(olderThanMs);
  const nowIso = toIsoTimestamp(now);
  const cutoffIso = new Date(now.getTime() - threshold).toISOString();

  const result = database
    .prepare(
      `
      UPDATE triage_runs
      SET
        status = 'failed',
        error_code = ?,
        error_message = ?,
        completed_at = ?
      WHERE status = 'processing'
        AND created_at <= ?
    `,
    )
    .run(INTERRUPTED_ERROR_CODE, INTERRUPTED_ERROR_MESSAGE, nowIso, cutoffIso);

  return result.changes;
}
