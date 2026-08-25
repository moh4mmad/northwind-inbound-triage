import "server-only";

import { z } from "zod";

const MINUTE_WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const TRIAGE_MAX_CONCURRENCY = 3;
export const DEFAULT_TRIAGE_REQUESTS_PER_MINUTE = 30;
export const DEFAULT_TRIAGE_REQUESTS_PER_DAY = 500;

const boundedEnvironmentInteger = (
  fallback: number,
  minimum: number,
  maximum: number,
) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

const admissionEnvironmentSchema = z
  .object({
    TRIAGE_REQUESTS_PER_MINUTE: boundedEnvironmentInteger(
      DEFAULT_TRIAGE_REQUESTS_PER_MINUTE,
      1,
      120,
    ),
    TRIAGE_REQUESTS_PER_DAY: boundedEnvironmentInteger(
      DEFAULT_TRIAGE_REQUESTS_PER_DAY,
      1,
      5_000,
    ),
  })
  .refine(
    (value) =>
      value.TRIAGE_REQUESTS_PER_DAY >= value.TRIAGE_REQUESTS_PER_MINUTE,
    {
      message:
        "TRIAGE_REQUESTS_PER_DAY must be greater than or equal to TRIAGE_REQUESTS_PER_MINUTE",
      path: ["TRIAGE_REQUESTS_PER_DAY"],
    },
  );

export interface TriageAdmissionConfig {
  maxConcurrent: number;
  requestsPerMinute: number;
  requestsPerDay: number;
}

export class TriageAdmissionConfigurationError extends Error {
  override readonly name = "TriageAdmissionConfigurationError";

  constructor(options?: ErrorOptions) {
    super("The triage admission policy is not configured correctly.", options);
  }
}

export interface TriageAdmissionPermit {
  release(): void;
}

export type TriageAdmissionDecision =
  | { allowed: true; permit: TriageAdmissionPermit }
  | {
      allowed: false;
      status: 429 | 503;
      code: "TRIAGE_BUSY" | "TRIAGE_DAILY_LIMIT" | "TRIAGE_MINUTE_LIMIT";
      message: string;
      retryAfterSeconds: number;
    };

interface FixedWindow {
  count: number;
  startedAt: number;
}

interface TriageAdmissionState {
  active: number;
  day: FixedWindow;
  minute: FixedWindow;
}

export function readTriageAdmissionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TriageAdmissionConfig {
  try {
    const parsed = admissionEnvironmentSchema.parse(environment);
    return {
      maxConcurrent: TRIAGE_MAX_CONCURRENCY,
      requestsPerMinute: parsed.TRIAGE_REQUESTS_PER_MINUTE,
      requestsPerDay: parsed.TRIAGE_REQUESTS_PER_DAY,
    };
  } catch (error) {
    throw new TriageAdmissionConfigurationError({ cause: error });
  }
}

export class TriageAdmissionController {
  private readonly state: TriageAdmissionState;

  constructor(
    private readonly config: TriageAdmissionConfig,
    private readonly now: () => number = Date.now,
  ) {
    assertConfig(config);
    const currentTime = this.readCurrentTime();
    this.state = {
      active: 0,
      day: { count: 0, startedAt: currentTime },
      minute: { count: 0, startedAt: currentTime },
    };
  }

  tryAcquire(): TriageAdmissionDecision {
    const currentTime = this.readCurrentTime();
    resetWindowIfExpired(this.state.day, DAY_WINDOW_MS, currentTime);
    resetWindowIfExpired(this.state.minute, MINUTE_WINDOW_MS, currentTime);

    if (this.state.day.count >= this.config.requestsPerDay) {
      return {
        allowed: false,
        status: 429,
        code: "TRIAGE_DAILY_LIMIT",
        message: "The daily analysis request limit has been reached.",
        retryAfterSeconds: secondsUntilReset(
          this.state.day,
          DAY_WINDOW_MS,
          currentTime,
        ),
      };
    }

    if (this.state.minute.count >= this.config.requestsPerMinute) {
      return {
        allowed: false,
        status: 429,
        code: "TRIAGE_MINUTE_LIMIT",
        message:
          "Too many analysis requests were submitted. Please retry shortly.",
        retryAfterSeconds: secondsUntilReset(
          this.state.minute,
          MINUTE_WINDOW_MS,
          currentTime,
        ),
      };
    }

    if (this.state.active >= this.config.maxConcurrent) {
      return {
        allowed: false,
        status: 503,
        code: "TRIAGE_BUSY",
        message: "The analysis queue is busy. Please retry shortly.",
        retryAfterSeconds: 1,
      };
    }

    this.state.active += 1;
    this.state.day.count += 1;
    this.state.minute.count += 1;

    let released = false;
    return {
      allowed: true,
      permit: {
        release: () => {
          if (released) return;
          released = true;
          this.state.active = Math.max(0, this.state.active - 1);
        },
      },
    };
  }

  private readCurrentTime(): number {
    const currentTime = this.now();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
      throw new TriageAdmissionConfigurationError();
    }
    return currentTime;
  }
}

interface GlobalAdmissionState {
  controller: TriageAdmissionController;
  fingerprint: string;
}

const globalForAdmission = globalThis as typeof globalThis & {
  __northwindTriageAdmission?: GlobalAdmissionState;
};

/**
 * This process-wide controller is appropriate for the local, single-process
 * application. A distributed deployment needs a shared rate limiter and queue.
 */
export function getTriageAdmissionController(): TriageAdmissionController {
  const config = readTriageAdmissionConfig();
  const fingerprint = `${config.maxConcurrent}:${config.requestsPerMinute}:${config.requestsPerDay}`;
  if (
    globalForAdmission.__northwindTriageAdmission?.fingerprint !== fingerprint
  ) {
    globalForAdmission.__northwindTriageAdmission = {
      controller: new TriageAdmissionController(config),
      fingerprint,
    };
  }

  return globalForAdmission.__northwindTriageAdmission.controller;
}

function assertConfig(config: TriageAdmissionConfig): void {
  if (
    !Number.isSafeInteger(config.maxConcurrent) ||
    config.maxConcurrent < 1 ||
    config.maxConcurrent > TRIAGE_MAX_CONCURRENCY ||
    !Number.isSafeInteger(config.requestsPerMinute) ||
    config.requestsPerMinute < 1 ||
    config.requestsPerMinute > 120 ||
    !Number.isSafeInteger(config.requestsPerDay) ||
    config.requestsPerDay < config.requestsPerMinute ||
    config.requestsPerDay > 5_000
  ) {
    throw new TriageAdmissionConfigurationError();
  }
}

function resetWindowIfExpired(
  window: FixedWindow,
  durationMs: number,
  currentTime: number,
): void {
  if (
    currentTime < window.startedAt ||
    currentTime - window.startedAt >= durationMs
  ) {
    window.count = 0;
    window.startedAt = currentTime;
  }
}

function secondsUntilReset(
  window: FixedWindow,
  durationMs: number,
  currentTime: number,
): number {
  return Math.max(
    1,
    Math.ceil((window.startedAt + durationMs - currentTime) / 1_000),
  );
}
