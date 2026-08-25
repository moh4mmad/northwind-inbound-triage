import {
  inboundMessageSchema,
  messageViewSchema,
  qualityReasonSchema,
  triageResultSchema,
  triageRunSchema,
  type InboundMessage,
  type MessageView,
  type TriageRun,
} from "@/lib/domain/schemas";
import { initializeDb } from "./connection";
import { PersistenceError } from "./errors";
import { recoverStaleProcessingRows } from "./maintenance";
import {
  DEFAULT_STALE_PROCESSING_MS,
  assertStaleThreshold,
  toIsoTimestamp,
} from "./time";
import type {
  AppDatabase,
  CompleteRunFailureInput,
  CompleteRunSuccessInput,
  CreateProcessingRunInput,
  StaleProcessingRecoveryOptions,
} from "./types";

interface MessageRow {
  id: string;
  received_at: string;
  channel: string;
  from_name: string;
  from_org: string;
  subject: string;
  body: string;
}

interface TriageRunRow {
  id: number;
  message_id: string;
  status: string;
  input_quality: string;
  review_reasons: string;
  summary: string | null;
  category: string | null;
  priority: string | null;
  suggested_next_action: string | null;
  provider: string;
  model: string;
  resolved_model: string | null;
  prompt_version: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

interface MessageViewRow extends MessageRow {
  run_id: number | null;
  run_message_id: string | null;
  run_status: string | null;
  run_input_quality: string | null;
  run_review_reasons: string | null;
  run_summary: string | null;
  run_category: string | null;
  run_priority: string | null;
  run_suggested_next_action: string | null;
  run_provider: string | null;
  run_model: string | null;
  run_resolved_model: string | null;
  run_prompt_version: string | null;
  run_error_code: string | null;
  run_error_message: string | null;
  run_attempt_count: number | null;
  run_input_tokens: number | null;
  run_output_tokens: number | null;
  run_duration_ms: number | null;
  run_created_at: string | null;
  run_completed_at: string | null;
}

const RUN_COLUMNS = `
  id,
  message_id,
  status,
  input_quality,
  review_reasons,
  summary,
  category,
  priority,
  suggested_next_action,
  provider,
  model,
  resolved_model,
  prompt_version,
  error_code,
  error_message,
  attempt_count,
  input_tokens,
  output_tokens,
  duration_ms,
  created_at,
  completed_at
`;

function mapRun(row: TriageRunRow): TriageRun {
  let reviewReasons: unknown;
  try {
    reviewReasons = JSON.parse(row.review_reasons);
  } catch (error) {
    throw new PersistenceError(
      "INVALID_RUN_TRANSITION",
      `Stored triage run ${row.id} contains invalid review reasons`,
      { cause: error },
    );
  }

  return triageRunSchema.parse({
    id: row.id,
    messageId: row.message_id,
    status: row.status,
    inputQuality: row.input_quality,
    reviewReasons,
    summary: row.summary,
    category: row.category,
    priority: row.priority,
    suggestedNextAction: row.suggested_next_action,
    provider: row.provider,
    model: row.model,
    resolvedModel: row.resolved_model,
    promptVersion: row.prompt_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attemptCount: row.attempt_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

function mapMessageView(row: MessageViewRow): MessageView {
  const latestRun =
    row.run_id === null
      ? null
      : mapRun({
          id: row.run_id,
          message_id: row.run_message_id ?? "",
          status: row.run_status ?? "",
          input_quality: row.run_input_quality ?? "",
          review_reasons: row.run_review_reasons ?? "[]",
          summary: row.run_summary,
          category: row.run_category,
          priority: row.run_priority,
          suggested_next_action: row.run_suggested_next_action,
          provider: row.run_provider ?? "",
          model: row.run_model ?? "",
          resolved_model: row.run_resolved_model,
          prompt_version: row.run_prompt_version ?? "",
          error_code: row.run_error_code,
          error_message: row.run_error_message,
          attempt_count: row.run_attempt_count ?? 0,
          input_tokens: row.run_input_tokens,
          output_tokens: row.run_output_tokens,
          duration_ms: row.run_duration_ms,
          created_at: row.run_created_at ?? "",
          completed_at: row.run_completed_at,
        });

  return messageViewSchema.parse({
    id: row.id,
    received_at: row.received_at,
    channel: row.channel,
    from_name: row.from_name,
    from_org: row.from_org,
    subject: row.subject,
    body: row.body,
    latestRun,
  });
}

function findRunById(runId: number, database: AppDatabase): TriageRun | null {
  const row = database
    .prepare(`SELECT ${RUN_COLUMNS} FROM triage_runs WHERE id = ?`)
    .get(runId) as TriageRunRow | undefined;

  return row ? mapRun(row) : null;
}

function requireRunById(runId: number, database: AppDatabase): TriageRun {
  const run = findRunById(runId, database);
  if (!run) {
    throw new PersistenceError("RUN_NOT_FOUND", "Triage run was not found");
  }
  return run;
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

function optionalMetric(
  value: number | null | undefined,
  field: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} cannot be empty`);
  return normalized.slice(0, maxLength);
}

function assertProcessingTransition(
  runId: number,
  database: AppDatabase,
): never {
  const run = findRunById(runId, database);
  if (!run) {
    throw new PersistenceError("RUN_NOT_FOUND", "Triage run was not found");
  }
  throw new PersistenceError(
    "INVALID_RUN_TRANSITION",
    "Only a processing triage run can be completed",
  );
}

export function listMessageViews(
  database: AppDatabase = initializeDb(),
): MessageView[] {
  const rows = database
    .prepare(
      `
      SELECT
        m.id,
        m.received_at,
        m.channel,
        m.from_name,
        m.from_org,
        m.subject,
        m.body,
        r.id AS run_id,
        r.message_id AS run_message_id,
        r.status AS run_status,
        r.input_quality AS run_input_quality,
        r.review_reasons AS run_review_reasons,
        r.summary AS run_summary,
        r.category AS run_category,
        r.priority AS run_priority,
        r.suggested_next_action AS run_suggested_next_action,
        r.provider AS run_provider,
        r.model AS run_model,
        r.resolved_model AS run_resolved_model,
        r.prompt_version AS run_prompt_version,
        r.error_code AS run_error_code,
        r.error_message AS run_error_message,
        r.attempt_count AS run_attempt_count,
        r.input_tokens AS run_input_tokens,
        r.output_tokens AS run_output_tokens,
        r.duration_ms AS run_duration_ms,
        r.created_at AS run_created_at,
        r.completed_at AS run_completed_at
      FROM messages AS m
      LEFT JOIN triage_runs AS r
        ON r.id = (
          SELECT latest.id
          FROM triage_runs AS latest
          WHERE latest.message_id = m.id
          ORDER BY latest.id DESC
          LIMIT 1
        )
      ORDER BY m.received_at DESC, m.id DESC
    `,
    )
    .all() as MessageViewRow[];

  return rows.map(mapMessageView);
}

export function getMessageById(
  messageId: string,
  database: AppDatabase = initializeDb(),
): InboundMessage | null {
  const row = database
    .prepare(
      `
      SELECT id, received_at, channel, from_name, from_org, subject, body
      FROM messages
      WHERE id = ?
    `,
    )
    .get(messageId) as MessageRow | undefined;

  return row ? inboundMessageSchema.parse(row) : null;
}

export function createProcessingRun(
  input: CreateProcessingRunInput,
  database: AppDatabase = initializeDb(),
): TriageRun {
  const reviewReasons = qualityReasonSchema
    .array()
    .parse([...input.reviewReasons]);
  const attemptCount = assertPositiveInteger(
    input.attemptCount ?? 1,
    "attemptCount",
  );
  const createdAt = toIsoTimestamp(input.now ?? new Date());

  return database
    .transaction(() => {
      if (!getMessageById(input.messageId, database)) {
        throw new PersistenceError(
          "MESSAGE_NOT_FOUND",
          "Inbound message was not found",
        );
      }

      try {
        const result = database
          .prepare(
            `
            INSERT INTO triage_runs (
              message_id,
              status,
              input_quality,
              review_reasons,
              provider,
              model,
              prompt_version,
              attempt_count,
              created_at
            ) VALUES (?, 'processing', ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            input.messageId,
            input.inputQuality,
            JSON.stringify(reviewReasons),
            input.provider,
            requiredText(input.model, "model", 300),
            requiredText(input.promptVersion, "promptVersion", 100),
            attemptCount,
            createdAt,
          );

        return requireRunById(Number(result.lastInsertRowid), database);
      } catch (error) {
        const existing = database
          .prepare(
            "SELECT 1 FROM triage_runs WHERE message_id = ? AND status = 'processing'",
          )
          .get(input.messageId);
        if (existing) {
          throw new PersistenceError(
            "PROCESSING_RUN_EXISTS",
            "This message is already being analyzed",
            { cause: error },
          );
        }
        throw error;
      }
    })
    .immediate();
}

export function completeRunSuccess(
  runId: number,
  input: CompleteRunSuccessInput,
  database: AppDatabase = initializeDb(),
): TriageRun {
  assertPositiveInteger(runId, "runId");
  const result = triageResultSchema.parse(input.result);
  const completedAt = toIsoTimestamp(input.now ?? new Date());
  const attemptCount =
    input.attemptCount === undefined
      ? null
      : assertPositiveInteger(input.attemptCount, "attemptCount");

  const update = database
    .prepare(
      `
      UPDATE triage_runs
      SET
        status = ?,
        summary = ?,
        category = ?,
        priority = ?,
        suggested_next_action = ?,
        resolved_model = ?,
        attempt_count = COALESCE(MAX(attempt_count, ?), attempt_count),
        input_tokens = ?,
        output_tokens = ?,
        duration_ms = ?,
        completed_at = ?
      WHERE id = ? AND status = 'processing'
    `,
    )
    .run(
      input.status,
      result.summary,
      result.category,
      result.priority,
      result.suggestedNextAction,
      requiredText(input.resolvedModel, "resolvedModel", 300),
      attemptCount,
      optionalMetric(input.inputTokens, "inputTokens"),
      optionalMetric(input.outputTokens, "outputTokens"),
      optionalMetric(input.durationMs, "durationMs"),
      completedAt,
      runId,
    );

  if (update.changes !== 1) {
    return assertProcessingTransition(runId, database);
  }

  return requireRunById(runId, database);
}

export function completeRunFailure(
  runId: number,
  input: CompleteRunFailureInput,
  database: AppDatabase = initializeDb(),
): TriageRun {
  assertPositiveInteger(runId, "runId");
  const completedAt = toIsoTimestamp(input.now ?? new Date());
  const attemptCount =
    input.attemptCount === undefined
      ? null
      : assertPositiveInteger(input.attemptCount, "attemptCount");

  const update = database
    .prepare(
      `
      UPDATE triage_runs
      SET
        status = 'failed',
        error_code = ?,
        error_message = ?,
        resolved_model = ?,
        attempt_count = COALESCE(MAX(attempt_count, ?), attempt_count),
        input_tokens = ?,
        output_tokens = ?,
        duration_ms = ?,
        completed_at = ?
      WHERE id = ? AND status = 'processing'
    `,
    )
    .run(
      requiredText(input.errorCode, "errorCode", 100),
      requiredText(input.errorMessage, "errorMessage", 500),
      input.resolvedModel === undefined || input.resolvedModel === null
        ? null
        : requiredText(input.resolvedModel, "resolvedModel", 300),
      attemptCount,
      optionalMetric(input.inputTokens, "inputTokens"),
      optionalMetric(input.outputTokens, "outputTokens"),
      optionalMetric(input.durationMs, "durationMs"),
      completedAt,
      runId,
    );

  if (update.changes !== 1) {
    return assertProcessingTransition(runId, database);
  }

  return requireRunById(runId, database);
}

export function recoverStaleProcessingRuns(
  options: StaleProcessingRecoveryOptions = {},
  database: AppDatabase = initializeDb({ recoverStaleAfterMs: false }),
): number {
  return recoverStaleProcessingRows(
    database,
    assertStaleThreshold(options.olderThanMs ?? DEFAULT_STALE_PROCESSING_MS),
    options.now ?? new Date(),
  );
}
