import "server-only";

import type { RuntimeConfig } from "@/lib/config/env";
import { getRuntimeConfig } from "@/lib/config/env";
import {
  completeRunFailure,
  completeRunSuccess,
  createProcessingRun,
  getMessageById,
  initializeDb,
  listMessageViews,
  PersistenceError,
  recoverStaleProcessingRuns,
  type AppDatabase,
} from "@/lib/db";
import {
  assessInputQuality,
  requiresInputReview,
} from "@/lib/domain/input-quality";
import {
  triageResultSchema,
  triageWireJsonSchema,
  type InboundMessage,
  type MessageView,
  type TriageResult,
} from "@/lib/domain/schemas";
import {
  analyzeWithRetry,
  AppError,
  createTriageProvider,
  providerError,
  sanitizeModelForDisplay,
  toProviderError,
  type TriageProvider,
} from "@/lib/llm";
import {
  buildTriageUserPrompt,
  PROMPT_VERSION,
  TRIAGE_SYSTEM_PROMPT,
} from "./prompt";
import { assertSafeTriageOutput, OutputPolicyError } from "./output-policy";

export interface TriageServiceDependencies {
  database?: AppDatabase;
  config?: RuntimeConfig;
  provider?: TriageProvider;
  nowMs?: () => number;
}

export async function triageMessage(
  messageId: string,
  signal?: AbortSignal,
  dependencies: TriageServiceDependencies = {},
): Promise<MessageView> {
  const database = dependencies.database ?? initializeDb();
  const message = getMessageById(messageId, database);
  if (!message) {
    throw new PersistenceError(
      "MESSAGE_NOT_FOUND",
      "Inbound message was not found",
    );
  }

  // Recovery belongs on the mutation path so a failed finalization cannot
  // lock a message for the lifetime of a warm process. The provider deadline
  // is deliberately shorter than this stale threshold.
  recoverStaleProcessingRuns({}, database);

  const config = dependencies.config ?? getRuntimeConfig();
  const provider = dependencies.provider;
  const providerName = provider?.name ?? config.provider;
  const model = provider
    ? sanitizeModelForDisplay(provider.name, provider.model)
    : config.displayModel;
  const assessment = assessInputQuality(message);
  const run = createProcessingRun(
    {
      messageId,
      inputQuality: assessment.quality,
      reviewReasons: assessment.reasons,
      provider: providerName,
      model,
      promptVersion: PROMPT_VERSION,
    },
    database,
  );

  const nowMs = dependencies.nowMs ?? Date.now;
  const startedAt = nowMs();
  let analysis: SuccessfulAnalysis;

  try {
    analysis = await requestAnalysis(
      provider,
      config,
      assessment.promptMessage,
      message,
      signal,
    );
  } catch (error) {
    const normalized = normalizeAnalysisError(error, providerName);
    const durationMs = elapsedMilliseconds(startedAt, nowMs());

    try {
      completeRunFailure(
        run.id,
        {
          errorCode: normalized.code.toUpperCase(),
          errorMessage: normalized.safeMessage,
          attemptCount: normalized.attempts,
          durationMs,
        },
        database,
      );
    } catch (persistenceError) {
      console.error("Failed to persist triage failure", {
        messageId,
        runId: run.id,
        provider: providerName,
        providerErrorCode: normalized.code,
        attempts: normalized.attempts,
        errorType:
          persistenceError instanceof Error
            ? persistenceError.name
            : "UnknownError",
      });
      throw new PersistenceError(
        "RUN_FINALIZATION_FAILED",
        "The triage run could not be finalized.",
        { cause: persistenceError },
      );
    }

    console.error("Triage analysis failed", {
      messageId,
      runId: run.id,
      provider: providerName,
      model,
      errorCode: normalized.code,
      attempts: normalized.attempts,
      durationMs,
    });
    throw normalized;
  }

  const needsReview =
    requiresInputReview(assessment) || analysis.result.category === "unknown";

  // Persistence finalization intentionally sits outside the provider error
  // boundary. A database failure must surface as an internal persistence error,
  // not be relabeled as a provider failure or trigger a second terminal update.
  completeRunSuccess(
    run.id,
    {
      status: needsReview ? "needs_review" : "succeeded",
      result: analysis.result,
      resolvedModel: analysis.resolvedModel,
      attemptCount: analysis.attempts,
      inputTokens: analysis.inputTokens,
      outputTokens: analysis.outputTokens,
      durationMs: elapsedMilliseconds(startedAt, nowMs()),
    },
    database,
  );

  return requireMessageView(messageId, database);
}

interface SuccessfulAnalysis {
  result: TriageResult;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  resolvedModel: string;
}

async function requestAnalysis(
  provider: TriageProvider | undefined,
  config: RuntimeConfig,
  promptMessage: InboundMessage,
  sourceMessage: InboundMessage,
  signal?: AbortSignal,
): Promise<SuccessfulAnalysis> {
  const activeProvider = provider ?? createTriageProvider(config);
  const response = await analyzeWithRetry(
    activeProvider,
    {
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      userPrompt: buildTriageUserPrompt(promptMessage),
      schema: triageWireJsonSchema as unknown as Record<string, unknown>,
      schemaName: "inbound_triage",
      signal,
    },
    {
      maxAttempts: config.maxAttempts,
      timeoutMs: config.timeoutMs,
      overallTimeoutMs: config.overallTimeoutMs,
    },
  );

  if (response.value.provider !== activeProvider.name) {
    throw providerError("invalid_output", activeProvider.name);
  }

  const parsed = triageResultSchema.safeParse(response.value.output);
  if (!parsed.success) {
    throw providerError("invalid_output", activeProvider.name, {
      cause: parsed.error,
    });
  }

  try {
    assertSafeTriageOutput(parsed.data, sourceMessage);
  } catch (error) {
    if (error instanceof OutputPolicyError) {
      throw providerError("policy_violation", activeProvider.name, {
        cause: error,
      });
    }
    throw error;
  }

  const resolvedModel = sanitizeModelForDisplay(
    activeProvider.name,
    response.value.model,
  );
  if (!resolvedModel) {
    throw providerError("invalid_output", activeProvider.name);
  }

  return {
    result: parsed.data,
    attempts: response.attempts,
    inputTokens: validatedTokenCount(
      response.value.usage.inputTokens,
      activeProvider.name,
    ),
    outputTokens: validatedTokenCount(
      response.value.usage.outputTokens,
      activeProvider.name,
    ),
    resolvedModel,
  };
}

function validatedTokenCount(
  value: number | null,
  provider: TriageProvider["name"],
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw providerError("invalid_output", provider);
  }
  return value;
}

function normalizeAnalysisError(
  error: unknown,
  provider: TriageProvider["name"],
): AppError {
  return error instanceof AppError ? error : toProviderError(error, provider);
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.round(completedAt - startedAt));
}

function requireMessageView(
  messageId: string,
  database: AppDatabase,
): MessageView {
  const message = listMessageViews(database).find(
    (candidate) => candidate.id === messageId,
  );
  if (!message) {
    throw new PersistenceError(
      "MESSAGE_NOT_FOUND",
      "Inbound message was not found",
    );
  }
  return message;
}
