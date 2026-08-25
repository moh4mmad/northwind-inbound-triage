import type { ProviderName } from "@/lib/domain/taxonomy";

export const APP_ERROR_CODES = [
  "configuration",
  "authentication",
  "permission_denied",
  "rate_limit",
  "timeout",
  "network",
  "provider_unavailable",
  "refusal",
  "invalid_output",
  "cancelled",
  "unknown",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const SAFE_MESSAGES: Record<AppErrorCode, string> = {
  configuration: "The selected AI provider is not configured correctly.",
  authentication: "The AI provider rejected its credentials.",
  permission_denied: "The AI provider denied access to the configured model.",
  rate_limit:
    "The AI provider is temporarily rate limited. Please retry shortly.",
  timeout: "The AI provider took too long to respond.",
  network: "The AI provider could not be reached.",
  provider_unavailable: "The AI provider is temporarily unavailable.",
  refusal: "The AI provider could not classify this message.",
  invalid_output: "The AI provider returned an invalid response.",
  cancelled: "The analysis was cancelled.",
  unknown: "The AI provider request failed.",
};

export interface AppErrorOptions {
  provider?: ProviderName;
  retryable?: boolean;
  safeMessage?: string;
  httpStatus?: number;
  attempts?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly provider?: ProviderName;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly httpStatus?: number;
  readonly attempts: number;

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
      cause: error,
    });
  }

  const reportedName = readString(error, "name");
  const errorName =
    reportedName && reportedName !== "Error"
      ? reportedName
      : readConstructorName(error);
  const status = readStatus(error);

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
    cause: error,
  });
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
    name === "ThrottlingException" ||
    name === "ServiceQuotaExceededException"
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
