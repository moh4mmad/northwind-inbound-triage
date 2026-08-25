import type { ProviderName } from "@/lib/domain/taxonomy";
import { MAX_PROVIDER_RETRY_AFTER_MS } from "./limits";

export const APP_ERROR_CODES = [
  "configuration",
  "authentication",
  "permission_denied",
  "quota_exceeded",
  "rate_limit",
  "timeout",
  "network",
  "provider_unavailable",
  "refusal",
  "invalid_output",
  "policy_violation",
  "cancelled",
  "unknown",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const SAFE_MESSAGES: Record<AppErrorCode, string> = {
  configuration: "The selected AI provider is not configured correctly.",
  authentication: "The AI provider rejected its credentials.",
  permission_denied: "The AI provider denied access to the configured model.",
  quota_exceeded:
    "The AI provider account has reached its usage or billing limit.",
  rate_limit:
    "The AI provider is temporarily rate limited. Please retry shortly.",
  timeout: "The AI provider took too long to respond.",
  network: "The AI provider could not be reached.",
  provider_unavailable: "The AI provider is temporarily unavailable.",
  refusal: "The AI provider could not classify this message.",
  invalid_output: "The AI provider returned an invalid response.",
  policy_violation:
    "The AI provider returned a suggested action that did not pass safety checks.",
  cancelled: "The analysis was cancelled.",
  unknown: "The AI provider request failed.",
};

export interface AppErrorOptions {
  provider?: ProviderName;
  retryable?: boolean;
  safeMessage?: string;
  httpStatus?: number;
  attempts?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly provider?: ProviderName;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly httpStatus?: number;
  readonly attempts: number;
  readonly retryAfterMs?: number;

  constructor(code: AppErrorCode, options: AppErrorOptions = {}) {
    const safeMessage = options.safeMessage ?? SAFE_MESSAGES[code];
    super(
      safeMessage,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.safeMessage = safeMessage;
    this.httpStatus = options.httpStatus;
    this.attempts = options.attempts ?? 1;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderError extends AppError {
  declare readonly provider: ProviderName;

  constructor(
    code: AppErrorCode,
    provider: ProviderName,
    options: Omit<AppErrorOptions, "provider"> = {},
  ) {
    super(code, { ...options, provider });
  }
}

export interface SafeError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}

export function toSafeError(error: unknown): SafeError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.safeMessage,
      retryable: error.retryable,
    };
  }

  return {
    code: "unknown",
    message: SAFE_MESSAGES.unknown,
    retryable: false,
  };
}

export function providerError(
  code: AppErrorCode,
  provider: ProviderName,
  options: Omit<AppErrorOptions, "provider"> = {},
): ProviderError {
  return new ProviderError(code, provider, options);
}

export function toProviderError(
  error: unknown,
  provider: ProviderName,
): ProviderError {
  if (error instanceof ProviderError) return error;

  if (error instanceof AppError) {
    return providerError(error.code, provider, {
      retryable: error.retryable,
      safeMessage: error.safeMessage,
      httpStatus: error.httpStatus,
      attempts: error.attempts,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }

  const reportedName = readString(error, "name");
  const errorName =
    reportedName && reportedName !== "Error"
      ? reportedName
      : readConstructorName(error);
  const status = readStatus(error);
  const providerCode = readProviderCode(error);

  if (isPermanentQuotaError(errorName, providerCode)) {
    return providerError("quota_exceeded", provider, {
      httpStatus: status,
      cause: error,
    });
  }

  if (isAuthenticationError(errorName, status)) {
    return providerError("authentication", provider, {
      httpStatus: status,
      cause: error,
    });
  }

  if (isPermissionError(errorName, status)) {
    return providerError("permission_denied", provider, {
      httpStatus: status,
      cause: error,
    });
  }

  if (isRateLimitError(errorName, status)) {
    return providerError("rate_limit", provider, {
      retryable: true,
      httpStatus: status,
      retryAfterMs: readRetryAfterMs(error),
      cause: error,
    });
  }

  if (isTimeoutError(errorName, status)) {
    return providerError("timeout", provider, {
      retryable: true,
      httpStatus: status,
      cause: error,
    });
  }

  if (isCancellationError(errorName)) {
    return providerError("cancelled", provider, { cause: error });
  }

  if (isConfigurationError(errorName, status)) {
    return providerError("configuration", provider, {
      httpStatus: status,
      cause: error,
    });
  }

  if (isUnavailableError(errorName, status)) {
    return providerError("provider_unavailable", provider, {
      retryable: true,
      httpStatus: status,
      cause: error,
    });
  }

  if (isNetworkError(error, errorName)) {
    return providerError("network", provider, {
      retryable: true,
      cause: error,
    });
  }

  return providerError("unknown", provider, { cause: error });
}

export function withAttemptCount(
  error: ProviderError,
  attempts: number,
): ProviderError {
  return providerError(error.code, error.provider, {
    retryable: error.retryable,
    safeMessage: error.safeMessage,
    httpStatus: error.httpStatus,
    attempts,
    retryAfterMs: error.retryAfterMs,
    cause: error,
  });
}

export function providerResponseError(
  code: string | null | undefined,
  provider: ProviderName,
): ProviderError {
  const normalized = code?.trim().toLowerCase();

  if (
    normalized === "insufficient_quota" ||
    normalized === "billing_hard_limit_reached" ||
    normalized === "billing_not_active" ||
    normalized === "usage_limit_reached" ||
    normalized === "quota_exceeded"
  ) {
    return providerError("quota_exceeded", provider);
  }
  if (normalized === "rate_limit_exceeded" || normalized === "rate_limit") {
    return providerError("rate_limit", provider, { retryable: true });
  }
  if (
    normalized === "authentication_error" ||
    normalized === "invalid_api_key"
  ) {
    return providerError("authentication", provider);
  }
  if (normalized === "permission_denied") {
    return providerError("permission_denied", provider);
  }
  if (
    normalized === "invalid_request_error" ||
    normalized === "model_not_found" ||
    normalized === "invalid_model"
  ) {
    return providerError("configuration", provider);
  }
  if (
    normalized === "content_filter" ||
    normalized === "safety_policy_violation"
  ) {
    return providerError("refusal", provider);
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return providerError("cancelled", provider);
  }
  if (
    normalized === "server_error" ||
    normalized === "service_unavailable" ||
    normalized === "overloaded"
  ) {
    return providerError("provider_unavailable", provider, {
      retryable: true,
    });
  }

  return providerError("unknown", provider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function readConstructorName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const constructor = value.constructor;
  if (typeof constructor !== "function") return undefined;
  return typeof constructor.name === "string" ? constructor.name : undefined;
}

function readStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;

  if (typeof value.status === "number") return value.status;
  if (typeof value.originalStatusCode === "number")
    return value.originalStatusCode;

  const metadata = value.$metadata;
  if (isRecord(metadata) && typeof metadata.httpStatusCode === "number") {
    return metadata.httpStatusCode;
  }

  return undefined;
}

function readProviderCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = readString(value, "code");
  if (direct) return direct;
  return isRecord(value.error) ? readString(value.error, "code") : undefined;
}

function readRetryAfterMs(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;

  const direct = value.retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return capRetryAfter(direct);
  }

  const headers =
    value.headers ??
    (isRecord(value.$response) ? value.$response.headers : null);
  const header = readHeader(headers, "retry-after");
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return capRetryAfter(seconds * 1_000);
  }

  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt)) return undefined;
  return capRetryAfter(Math.max(0, retryAt - Date.now()));
}

function readHeader(value: unknown, name: string): string | undefined {
  if (!isRecord(value)) return undefined;

  const get = value.get;
  if (typeof get === "function") {
    try {
      const header = get.call(value, name) as unknown;
      if (typeof header === "string") return header.trim();
    } catch {
      return undefined;
    }
  }

  const entry = Object.entries(value).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  if (typeof entry === "string") return entry.trim();
  if (Array.isArray(entry) && typeof entry[0] === "string") {
    return entry[0].trim();
  }
  return undefined;
}

function capRetryAfter(milliseconds: number): number {
  // Keep provider hints useful without allowing a malformed response to hold a
  // worker indefinitely. The overall retry deadline remains the final bound.
  return Math.min(
    MAX_PROVIDER_RETRY_AFTER_MS,
    Math.max(0, Math.round(milliseconds)),
  );
}

function isPermanentQuotaError(
  name: string | undefined,
  code: string | undefined,
): boolean {
  return (
    name === "ServiceQuotaExceededException" ||
    code?.toLowerCase() === "insufficient_quota" ||
    code?.toLowerCase() === "billing_hard_limit_reached" ||
    code?.toLowerCase() === "billing_not_active" ||
    code?.toLowerCase() === "usage_limit_reached" ||
    code?.toLowerCase() === "quota_exceeded"
  );
}

function isAuthenticationError(
  name: string | undefined,
  status: number | undefined,
): boolean {
  return (
    status === 401 ||
    name === "AuthenticationError" ||
    name === "TokenProviderError" ||
    name === "UnrecognizedClientException" ||
    name === "ExpiredTokenException" ||
    name === "InvalidSignatureException"
  );
}

function isPermissionError(
  name: string | undefined,
  status: number | undefined,
): boolean {
  return (
    status === 403 ||
    name === "PermissionDeniedError" ||
    name === "AccessDeniedException"
  );
}

function isRateLimitError(
  name: string | undefined,
  status: number | undefined,
): boolean {
  return (
    status === 429 ||
    name === "RateLimitError" ||
    name === "ThrottlingException"
  );
}

function isTimeoutError(
  name: string | undefined,
  status: number | undefined,
): boolean {
  return (
    status === 408 ||
    status === 504 ||
    name === "TimeoutError" ||
    name === "APIConnectionTimeoutError" ||
    name === "ModelTimeoutException"
  );
}

function isCancellationError(name: string | undefined): boolean {
  return name === "AbortError" || name === "APIUserAbortError";
}

function isConfigurationError(
  name: string | undefined,
  status: number | undefined,
): boolean {
  return (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    name === "BadRequestError" ||
    name === "CredentialsProviderError" ||
    name === "NotFoundError" ||
    name === "UnprocessableEntityError" ||
    name === "ValidationException" ||
    name === "ResourceNotFoundException"
  );
}

function isUnavailableError(
  name: string | undefined,
  status: number | undefined,
): boolean {
  return (
    (status !== undefined && status >= 500) ||
    name === "InternalServerError" ||
    name === "InternalServerException" ||
    name === "ServiceUnavailableException" ||
    name === "ModelNotReadyException" ||
    name === "ModelErrorException"
  );
}

function isNetworkError(
  error: unknown,
  resolvedName: string | undefined,
): boolean {
  if (!isRecord(error)) return false;

  const code =
    readString(error, "code") ??
    (isRecord(error.cause) ? readString(error.cause, "code") : undefined);

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT"
  ) {
    return true;
  }

  return resolvedName === "APIConnectionError" || resolvedName === "FetchError";
}
