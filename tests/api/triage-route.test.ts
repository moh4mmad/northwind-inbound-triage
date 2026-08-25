import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceError } from "@/lib/db";
import { TriageAdmissionConfigurationError } from "@/lib/http/triage-admission";
import { AppError } from "@/lib/llm";

const { admissionControllerMock, releasePermitMock, triageMessageMock } =
  vi.hoisted(() => ({
    admissionControllerMock: vi.fn(),
    releasePermitMock: vi.fn(),
    triageMessageMock: vi.fn(),
  }));

vi.mock("@/lib/http/triage-admission", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/http/triage-admission")>();
  return {
    ...actual,
    getTriageAdmissionController: admissionControllerMock,
  };
});

vi.mock("@/lib/triage/triage-service", () => ({
  triageMessage: triageMessageMock,
}));

import { POST } from "@/app/api/messages/[id]/triage/route";

interface RequestOptions {
  body?: string;
  contentType?: string | null;
  host?: string;
  origin?: string | null;
  requestHeader?: string | null;
}

function request(id: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  const contentType =
    options.contentType === undefined
      ? "application/json"
      : options.contentType;
  const origin =
    options.origin === undefined ? "http://localhost" : options.origin;
  const requestHeader =
    options.requestHeader === undefined ? "triage" : options.requestHeader;
  if (contentType !== null) headers.set("Content-Type", contentType);
  if (origin !== null) headers.set("Origin", origin);
  if (requestHeader !== null) {
    headers.set("X-Northwind-Request", requestHeader);
  }

  return POST(
    new Request(
      `http://${options.host ?? "localhost"}/api/messages/${id}/triage`,
      {
        method: "POST",
        headers,
        body: options.body ?? "{}",
      },
    ),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  releasePermitMock.mockReset();
  admissionControllerMock.mockReset().mockReturnValue({
    tryAcquire: vi.fn(() => ({
      allowed: true,
      permit: { release: releasePermitMock },
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  triageMessageMock.mockReset();
});

describe("POST /api/messages/[id]/triage", () => {
  it("rejects invalid IDs before calling the service", async () => {
    const response = await request("not-an-id");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "The message ID is invalid.",
        retryable: false,
      },
    });
    expect(triageMessageMock).not.toHaveBeenCalled();
    expect(admissionControllerMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      { host: "attacker.example", origin: "http://attacker.example" },
      403,
      "NON_LOCAL_REQUEST",
    ],
    [{ origin: "https://attacker.example" }, 403, "CROSS_ORIGIN_REQUEST"],
    [{ requestHeader: null }, 403, "MISSING_REQUEST_HEADER"],
    [{ contentType: "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    [{ body: "[]" }, 400, "INVALID_REQUEST_BODY"],
  ] as const)(
    "rejects an invalid request contract with %i",
    async (options, status, code) => {
      const response = await request("inb-001", options);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code, retryable: false },
      });
      expect(admissionControllerMock).not.toHaveBeenCalled();
      expect(triageMessageMock).not.toHaveBeenCalled();
    },
  );

  it("returns a safe response when admission configuration is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    admissionControllerMock.mockImplementationOnce(() => {
      throw new TriageAdmissionConfigurationError();
    });

    const response = await request("inb-001");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ADMISSION_CONFIGURATION",
        message: "Analysis requests are temporarily unavailable.",
        retryable: false,
      },
    });
    expect(triageMessageMock).not.toHaveBeenCalled();
  });

  it("returns only the browser-safe message projection", async () => {
    triageMessageMock.mockResolvedValue({
      id: "inb-001",
      received_at: "2026-07-20T09:14:00-04:00",
      channel: "email",
      from_name: "Gregory Palmer",
      from_org: "(individual)",
      subject: "Planning question",
      body: "I would like to discuss planning services.",
      latestRun: {
        id: 7,
        messageId: "inb-001",
        status: "succeeded",
        inputQuality: "valid",
        reviewReasons: [],
        summary: "A prospect asks about planning services.",
        category: "prospect",
        priority: "medium",
        suggestedNextAction: "Review the inquiry and assign an advisor.",
        provider: "anthropic",
        model: "requested-model",
        resolvedModel: "resolved-model",
        promptVersion: "triage-v2",
        errorCode: null,
        errorMessage: null,
        attemptCount: 1,
        inputTokens: 100,
        outputTokens: 40,
        durationMs: 250,
        createdAt: "2026-07-20T14:00:00.000Z",
        completedAt: "2026-07-20T14:00:00.250Z",
      },
    });

    const response = await request("inb-001");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      message: {
        id: "inb-001",
        received_at: "2026-07-20T09:14:00-04:00",
        channel: "email",
        from_name: "Gregory Palmer",
        from_org: "(individual)",
        subject: "Planning question",
        body: "I would like to discuss planning services.",
        latestRun: {
          status: "succeeded",
          inputQuality: "valid",
          reviewReasons: [],
          summary: "A prospect asks about planning services.",
          category: "prospect",
          priority: "medium",
          suggestedNextAction: "Review the inquiry and assign an advisor.",
          errorCode: null,
          errorMessage: null,
        },
      },
    });
    expect(releasePermitMock).toHaveBeenCalledOnce();
  });

  it.each([
    [429, "TRIAGE_MINUTE_LIMIT", 17],
    [503, "TRIAGE_BUSY", 1],
  ] as const)(
    "returns a safe %i admission response with Retry-After",
    async (status, code, retryAfterSeconds) => {
      admissionControllerMock.mockReturnValueOnce({
        tryAcquire: vi.fn(() => ({
          allowed: false,
          status,
          code,
          message: "Analysis is temporarily unavailable.",
          retryAfterSeconds,
        })),
      });

      const response = await request("inb-001");

      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(
        String(retryAfterSeconds),
      );
      await expect(response.json()).resolves.toEqual({
        error: {
          code,
          message: "Analysis is temporarily unavailable.",
          retryable: true,
        },
      });
      expect(triageMessageMock).not.toHaveBeenCalled();
      expect(releasePermitMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["MESSAGE_NOT_FOUND", 404, "NOT_FOUND", false],
    ["PROCESSING_RUN_EXISTS", 409, "ALREADY_RUNNING", true],
  ] as const)(
    "maps persistence error %s to a safe response",
    async (code, status, responseCode, retryable) => {
      triageMessageMock.mockRejectedValue(
        new PersistenceError(code, "private database detail"),
      );

      const response = await request("inb-001");
      const body = (await response.json()) as {
        error: { code: string; message: string; retryable: boolean };
      };

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.error).toMatchObject({ code: responseCode, retryable });
      expect(body.error.message).not.toContain("private database detail");
    },
  );

  it.each([
    ["rate_limit", 429, true, true],
    ["quota_exceeded", 429, false, false],
    ["timeout", 504, true, true],
    ["configuration", 503, false, false],
    ["authentication", 502, false, false],
    ["permission_denied", 502, false, false],
    ["refusal", 502, false, false],
    ["policy_violation", 502, false, false],
    ["invalid_output", 502, false, false],
    ["network", 503, true, true],
    ["provider_unavailable", 503, true, true],
    ["cancelled", 408, false, true],
    ["unknown", 502, false, false],
  ] as const)(
    "maps %s provider errors to HTTP %i",
    async (code, status, internalRetryable, responseRetryable) => {
      triageMessageMock.mockRejectedValue(
        new AppError(code, { retryable: internalRetryable }),
      );

      const response = await request("inb-001");
      const body = (await response.json()) as {
        error: { code: string; message: string; retryable: boolean };
      };

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (status === 429 || status === 503) {
        expect(response.headers.get("retry-after")).toMatch(/^\d+$/u);
      } else {
        expect(response.headers.get("retry-after")).toBeNull();
      }
      expect(body.error).toMatchObject({
        code: code.toUpperCase(),
        retryable: responseRetryable,
      });
    },
  );

  it("forwards a bounded provider retry delay as whole seconds", async () => {
    triageMessageMock.mockRejectedValue(
      new AppError("rate_limit", {
        retryable: true,
        retryAfterMs: 1_250,
      }),
    );

    const response = await request("inb-001");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(releasePermitMock).toHaveBeenCalledOnce();
  });

  it("does not expose unexpected server errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    triageMessageMock.mockRejectedValue(new Error("secret database path"));

    const response = await request("inb-001");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL",
        message: "The message could not be analyzed.",
        retryable: true,
      },
    });
    expect(releasePermitMock).toHaveBeenCalledOnce();
  });
});
