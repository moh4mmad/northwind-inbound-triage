import type { ProviderName } from "@/lib/domain/taxonomy";
import { providerError, toProviderError, withAttemptCount } from "./errors";
import {
  MAX_PROVIDER_ATTEMPTS,
  MAX_PROVIDER_ATTEMPT_TIMEOUT_MS,
  MAX_PROVIDER_OVERALL_TIMEOUT_MS,
} from "./limits";
import type {
  TriageProvider,
  TriageProviderRequest,
  TriageProviderResult,
} from "./types";

export interface RetryContext {
  attempt: number;
  signal: AbortSignal;
}

export interface ProviderRetryOptions {
  provider: ProviderName;
  maxAttempts: number;
  timeoutMs: number;
  overallTimeoutMs: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ProviderRetryResult<T> {
  value: T;
  attempts: number;
}

export async function withProviderRetry<T>(
  operation: (context: RetryContext) => Promise<T>,
  options: ProviderRetryOptions,
): Promise<ProviderRetryResult<T>> {
  assertRetryOptions(options);

  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const deadlineMs = now() + options.overallTimeoutMs;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const value = await runBoundedAttempt(
        operation,
        attempt,
        options,
        remainingAttemptTime(deadlineMs, now, options, attempt),
      );
      return { value, attempts: attempt };
    } catch (error) {
      const normalized = toProviderError(error, options.provider);
      if (!normalized.retryable || attempt === options.maxAttempts) {
        throw withAttemptCount(normalized, attempt);
      }

      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitterMultiplier = 0.75 + random() * 0.5;
      const retryDelayMs = Math.max(
        Math.round(exponentialDelay * jitterMultiplier),
        normalized.retryAfterMs ?? 0,
      );
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0 || retryDelayMs >= remainingMs) {
        throw withAttemptCount(
          providerError("timeout", options.provider, { retryable: true }),
          attempt,
        );
      }
      try {
        await runBoundedAttempt(
          ({ signal }) => sleep(retryDelayMs, signal),
          attempt,
          options,
          remainingMs,
        );
      } catch (sleepError) {
        throw withAttemptCount(
          toProviderError(sleepError, options.provider),
          attempt,
        );
      }
    }
  }

  throw providerError("unknown", options.provider);
}

export function analyzeWithRetry(
  provider: TriageProvider,
  request: TriageProviderRequest,
  options: Omit<ProviderRetryOptions, "provider" | "signal">,
): Promise<ProviderRetryResult<TriageProviderResult>> {
  return withProviderRetry(
    ({ signal }) => provider.analyze({ ...request, signal }),
    {
      ...options,
      provider: provider.name,
      signal: request.signal,
    },
  );
}

async function runBoundedAttempt<T>(
  operation: (context: RetryContext) => Promise<T>,
  attempt: number,
  options: ProviderRetryOptions,
  timeoutMs: number,
): Promise<T> {
  if (options.signal?.aborted) {
    throw providerError("cancelled", options.provider, {
      cause: options.signal.reason,
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  let externallyCancelled = false;
  let rejectBoundary: ((reason: unknown) => void) | undefined;

  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });

  const onExternalAbort = () => {
    externallyCancelled = true;
    controller.abort(options.signal?.reason);
    rejectBoundary?.(
      providerError("cancelled", options.provider, {
        cause: options.signal?.reason,
      }),
    );
  };

  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    const timeoutError = providerError("timeout", options.provider, {
      retryable: true,
    });
    controller.abort(timeoutError);
    rejectBoundary?.(timeoutError);
  }, timeoutMs);

  try {
    return await Promise.race([
      operation({ attempt, signal: controller.signal }),
      boundary,
    ]);
  } catch (error) {
    if (timedOut) {
      throw providerError("timeout", options.provider, {
        retryable: true,
        cause: error,
      });
    }
    if (externallyCancelled) {
      throw providerError("cancelled", options.provider, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function assertRetryOptions(options: ProviderRetryOptions): void {
  if (
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > MAX_PROVIDER_ATTEMPTS
  ) {
    throw providerError("configuration", options.provider, {
      safeMessage: "The AI retry policy is not configured correctly.",
    });
  }

  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_PROVIDER_ATTEMPT_TIMEOUT_MS
  ) {
    throw providerError("configuration", options.provider, {
      safeMessage: "The AI timeout is not configured correctly.",
    });
  }

  if (
    !Number.isFinite(options.overallTimeoutMs) ||
    options.overallTimeoutMs <= 0 ||
    options.overallTimeoutMs > MAX_PROVIDER_OVERALL_TIMEOUT_MS ||
    options.overallTimeoutMs < options.timeoutMs
  ) {
    throw providerError("configuration", options.provider, {
      safeMessage: "The overall AI deadline is not configured correctly.",
    });
  }

  if (
    options.baseDelayMs !== undefined &&
    (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0)
  ) {
    throw providerError("configuration", options.provider, {
      safeMessage: "The AI retry delay is not configured correctly.",
    });
  }
}

function remainingAttemptTime(
  deadlineMs: number,
  now: () => number,
  options: ProviderRetryOptions,
  attempt: number,
): number {
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) {
    throw withAttemptCount(
      providerError("timeout", options.provider, { retryable: true }),
      attempt,
    );
  }
  return Math.min(options.timeoutMs, remainingMs);
}

async function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new AppCancellationError(signal.reason);
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new AppCancellationError(signal?.reason));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class AppCancellationError extends Error {
  constructor(cause: unknown) {
    super(
      "The operation was aborted.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "AbortError";
  }
}
