import { describe, expect, it } from "vitest";
import {
  dashboardMessageSchema,
  toDashboardMessage,
} from "@/lib/domain/dashboard";
import type { MessageView } from "@/lib/domain/schemas";

const source = {
  id: "inb-001",
  received_at: "2026-07-20T09:14:00-04:00",
  channel: "email",
  from_name: "Gregory Palmer",
  from_org: "(individual)",
  subject: "Planning question",
  body: "I would like to discuss planning services.",
};

describe("dashboard DTO", () => {
  it("keeps provider and accounting metadata on the server", () => {
    const internal = {
      ...source,
      latestRun: {
        id: 1,
        messageId: source.id,
        status: "succeeded",
        inputQuality: "valid",
        reviewReasons: [],
        summary: "A prospective client asks about planning services.",
        category: "prospect",
        priority: "medium",
        suggestedNextAction: "Review the inquiry and assign an advisor.",
        provider: "anthropic",
        model: "requested-model",
        resolvedModel: "resolved-model",
        promptVersion: "triage-v2",
        promptHash: "private-audit-hash",
        errorCode: null,
        errorMessage: null,
        attemptCount: 1,
        inputTokens: 120,
        outputTokens: 40,
        durationMs: 250,
        createdAt: "2026-07-20T14:00:00.000Z",
        completedAt: "2026-07-20T14:00:00.250Z",
      },
    } as unknown as MessageView;

    const projected = toDashboardMessage(internal);

    expect(projected.latestRun).toEqual({
      status: "succeeded",
      inputQuality: "valid",
      reviewReasons: [],
      summary: "A prospective client asks about planning services.",
      category: "prospect",
      priority: "medium",
      suggestedNextAction: "Review the inquiry and assign an advisor.",
      errorCode: null,
      errorMessage: null,
    });
    expect(projected.latestRun).not.toHaveProperty("provider");
    expect(projected.latestRun).not.toHaveProperty("inputTokens");
    expect(projected.latestRun).not.toHaveProperty("promptVersion");
  });

  it("rejects unexpected run metadata at the browser boundary", () => {
    const parsed = dashboardMessageSchema.safeParse({
      ...source,
      latestRun: {
        status: "succeeded",
        inputQuality: "valid",
        reviewReasons: [],
        summary: "A prospective client asks about planning services.",
        category: "prospect",
        priority: "medium",
        suggestedNextAction: "Review the inquiry and assign an advisor.",
        errorCode: null,
        errorMessage: null,
        provider: "anthropic",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    { summary: "Spoofed\u202Esummary" },
    { errorCode: "bad\ncode" },
    { errorMessage: "First line\nSecond line" },
  ])(
    "rejects unsafe persisted result text at the browser boundary",
    (change) => {
      const parsed = dashboardMessageSchema.safeParse({
        ...source,
        latestRun: {
          status: "failed",
          inputQuality: "valid",
          reviewReasons: [],
          summary: null,
          category: null,
          priority: null,
          suggestedNextAction: null,
          errorCode: "INVALID_OUTPUT",
          errorMessage: "The provider returned an invalid response.",
          ...change,
        },
      });

      expect(parsed.success).toBe(false);
    },
  );
});
