import { describe, expect, it } from "vitest";
import { createProcessingRun, initializeDb, listMessageViews } from "@/lib/db";
import { getDashboardData } from "@/lib/triage/dashboard-service";

describe("getDashboardData", () => {
  it("is read-only and does not fail an old processing run", () => {
    const database = initializeDb({
      path: ":memory:",
      recoverStaleAfterMs: false,
    });

    try {
      createProcessingRun(
        {
          messageId: "inb-001",
          inputQuality: "valid",
          reviewReasons: [],
          provider: "anthropic",
          model: "claude-sonnet-5",
          promptVersion: "triage-v2",
          now: new Date("2026-07-20T10:00:00.000Z"),
        },
        database,
      );

      const result = getDashboardData({
        database,
        provider: {
          name: "anthropic",
          model: "claude-sonnet-5",
          configured: true,
          configurationStatus: "locally_configured",
        },
      });

      expect(
        result.messages.find((message) => message.id === "inb-001")?.latestRun
          ?.status,
      ).toBe("processing");
      expect(
        listMessageViews(database).find((message) => message.id === "inb-001")
          ?.latestRun?.status,
      ).toBe("processing");
    } finally {
      database.close();
    }
  });
});
