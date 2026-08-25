import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRIAGE_REQUESTS_PER_DAY,
  DEFAULT_TRIAGE_REQUESTS_PER_MINUTE,
  readTriageAdmissionConfig,
  TriageAdmissionConfigurationError,
  TriageAdmissionController,
  TRIAGE_MAX_CONCURRENCY,
  type TriageAdmissionDecision,
  type TriageAdmissionPermit,
} from "@/lib/http/triage-admission";

function requirePermit(
  decision: TriageAdmissionDecision,
): TriageAdmissionPermit {
  if (!decision.allowed) throw new Error("Expected an admission permit");
  return decision.permit;
}

describe("triage admission configuration", () => {
  it("uses bounded local defaults", () => {
    expect(readTriageAdmissionConfig({})).toEqual({
      maxConcurrent: TRIAGE_MAX_CONCURRENCY,
      requestsPerMinute: DEFAULT_TRIAGE_REQUESTS_PER_MINUTE,
      requestsPerDay: DEFAULT_TRIAGE_REQUESTS_PER_DAY,
    });
  });

  it("parses valid environment overrides", () => {
    expect(
      readTriageAdmissionConfig({
        TRIAGE_REQUESTS_PER_MINUTE: "12",
        TRIAGE_REQUESTS_PER_DAY: "200",
      }),
    ).toMatchObject({ requestsPerMinute: 12, requestsPerDay: 200 });
  });

  it.each([
    { TRIAGE_REQUESTS_PER_MINUTE: "0" },
    { TRIAGE_REQUESTS_PER_MINUTE: "121" },
    { TRIAGE_REQUESTS_PER_MINUTE: "not-a-number" },
    { TRIAGE_REQUESTS_PER_DAY: "5001" },
    {
      TRIAGE_REQUESTS_PER_MINUTE: "50",
      TRIAGE_REQUESTS_PER_DAY: "49",
    },
  ])("rejects invalid environment limits", (environment) => {
    expect(() => readTriageAdmissionConfig(environment)).toThrow(
      TriageAdmissionConfigurationError,
    );
  });
});

describe("TriageAdmissionController", () => {
  it("caps global work at three and releases permits idempotently", () => {
    const controller = new TriageAdmissionController({
      maxConcurrent: 3,
      requestsPerMinute: 10,
      requestsPerDay: 20,
    });
    const first = requirePermit(controller.tryAcquire());
    requirePermit(controller.tryAcquire());
    requirePermit(controller.tryAcquire());

    expect(controller.tryAcquire()).toMatchObject({
      allowed: false,
      status: 503,
      code: "TRIAGE_BUSY",
      retryAfterSeconds: 1,
    });

    first.release();
    first.release();
    requirePermit(controller.tryAcquire());
    expect(controller.tryAcquire()).toMatchObject({
      allowed: false,
      code: "TRIAGE_BUSY",
    });
  });

  it("enforces and resets the minute quota", () => {
    let now = 0;
    const controller = new TriageAdmissionController(
      { maxConcurrent: 3, requestsPerMinute: 2, requestsPerDay: 5 },
      () => now,
    );

    requirePermit(controller.tryAcquire()).release();
    requirePermit(controller.tryAcquire()).release();
    expect(controller.tryAcquire()).toMatchObject({
      allowed: false,
      status: 429,
      code: "TRIAGE_MINUTE_LIMIT",
      retryAfterSeconds: 60,
    });

    now = 60_000;
    expect(controller.tryAcquire().allowed).toBe(true);
  });

  it("enforces and resets the rolling daily window", () => {
    let now = 0;
    const controller = new TriageAdmissionController(
      { maxConcurrent: 3, requestsPerMinute: 1, requestsPerDay: 2 },
      () => now,
    );

    requirePermit(controller.tryAcquire()).release();
    now = 60_000;
    requirePermit(controller.tryAcquire()).release();
    now = 120_000;
    expect(controller.tryAcquire()).toMatchObject({
      allowed: false,
      status: 429,
      code: "TRIAGE_DAILY_LIMIT",
      retryAfterSeconds: 86_280,
    });

    now = 24 * 60 * 60 * 1_000;
    expect(controller.tryAcquire().allowed).toBe(true);
  });
});
