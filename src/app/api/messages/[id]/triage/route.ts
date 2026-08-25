import { PersistenceError } from "@/lib/db";
import {
  getTriageAdmissionController,
  TriageAdmissionConfigurationError,
  type TriageAdmissionPermit,
} from "@/lib/http/triage-admission";
import {
  assertValidTriageRequest,
  TriageRequestGuardError,
} from "@/lib/http/triage-request-guard";
import { toDashboardMessage } from "@/lib/domain/dashboard";
import { AppError, toSafeError } from "@/lib/llm";
import { triageMessage } from "@/lib/triage/triage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE_ID_PATTERN = /^inb-\d{3}$/u;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let messageId: string | undefined;
  let permit: TriageAdmissionPermit | undefined;

  try {
    await assertValidTriageRequest(request);

    const { id } = await context.params;
    messageId = id;
    if (!MESSAGE_ID_PATTERN.test(id)) {
      return errorResponse(
        400,
        "INVALID_INPUT",
        "The message ID is invalid.",
        false,
      );
    }

    const admission = getTriageAdmissionController().tryAcquire();
    if (!admission.allowed) {
      return errorResponse(
        admission.status,
        admission.code,
        admission.message,
        true,
        admission.retryAfterSeconds,
      );
    }
    permit = admission.permit;

    const message = await triageMessage(id, request.signal);
    return Response.json(
      { message: toDashboardMessage(message) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TriageRequestGuardError) {
      return errorResponse(error.status, error.code, error.safeMessage, false);
    }

    if (error instanceof TriageAdmissionConfigurationError) {
      console.error("Triage admission configuration failed", {
        errorType: error.name,
      });
      return errorResponse(
        503,
        "ADMISSION_CONFIGURATION",
        "Analysis requests are temporarily unavailable.",
        false,
        60,
      );
    }

    if (error instanceof PersistenceError) {
      if (error.code === "MESSAGE_NOT_FOUND") {
        return errorResponse(
          404,
          "NOT_FOUND",
          "The message was not found.",
          false,
        );
      }
      if (error.code === "PROCESSING_RUN_EXISTS") {
        return errorResponse(
          409,
          "ALREADY_RUNNING",
          "This message is already being analyzed.",
          true,
        );
      }
    }

    if (error instanceof AppError) {
      const safe = toSafeError(error);
      const manuallyRetryable = safe.retryable || error.code === "cancelled";
      return errorResponse(
        statusForAppError(error),
        safe.code.toUpperCase(),
        safe.message,
        manuallyRetryable,
        error.retryAfterMs === undefined
          ? undefined
          : Math.max(1, Math.ceil(error.retryAfterMs / 1_000)),
      );
    }

    console.error("Unhandled triage route error", {
      messageId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "INTERNAL",
      "The message could not be analyzed.",
      true,
    );
  } finally {
    permit?.release();
  }
}

function statusForAppError(error: AppError): number {
  switch (error.code) {
    case "rate_limit":
    case "quota_exceeded":
      return 429;
    case "timeout":
      return 504;
    case "configuration":
      return 503;
    case "authentication":
    case "permission_denied":
    case "refusal":
    case "policy_violation":
    case "invalid_output":
      return 502;
    case "network":
    case "provider_unavailable":
      return 503;
    case "cancelled":
      return 408;
    case "unknown":
      return 502;
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  retryAfterSeconds?: number,
): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (status === 429 || status === 503) {
    headers["Retry-After"] = String(
      retryAfterSeconds ?? (status === 429 ? 30 : 5),
    );
  }

  return Response.json(
    { error: { code, message, retryable } },
    { status, headers },
  );
}
