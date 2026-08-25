import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PersistenceError,
  completeRunFailure,
  completeRunSuccess,
  createProcessingRun,
  getMessageById,
  initializeDb,
  listMessageViews,
  recoverStaleProcessingRuns,
  type AppDatabase,
  type CreateProcessingRunInput,
} from "@/lib/db";

const openDatabases: AppDatabase[] = [];

function testDatabase(): AppDatabase {
  const database = new BetterSqlite3(":memory:");
  openDatabases.push(database);
  return initializeDb({ database, recoverStaleAfterMs: false });
}

function processingInput(
  overrides: Partial<CreateProcessingRunInput> = {},
): CreateProcessingRunInput {
  return {
    messageId: "inb-001",
    inputQuality: "valid",
    reviewReasons: ["unknown_organization"],
    provider: "anthropic",
    model: "claude-sonnet-5",
    promptVersion: "triage-v1",
    now: new Date("2026-07-21T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
});

describe("message repository", () => {
  it("lists newest messages first with no fabricated run state", () => {
    const database = testDatabase();

    const messages = listMessageViews(database);

    expect(messages).toHaveLength(13);
    expect(messages[0]?.id).toBe("inb-013");
    expect(messages.at(-1)?.id).toBe("inb-001");
    expect(messages.every((message) => message.latestRun === null)).toBe(true);
  });

  it("returns a validated raw message or null", () => {
    const database = testDatabase();

    expect(getMessageById("inb-011", database)).toMatchObject({
      id: "inb-011",
      from_name: "=?utf-8?B?",
    });
    expect(getMessageById("inb-999", database)).toBeNull();
  });
});

describe("triage run lifecycle", () => {
  it("creates a typed processing run without leaving a transaction open", () => {
    const database = testDatabase();

    const run = createProcessingRun(processingInput(), database);

    expect(run).toMatchObject({
      id: 1,
      messageId: "inb-001",
      status: "processing",
      inputQuality: "valid",
      reviewReasons: ["unknown_organization"],
      attemptCount: 1,
      completedAt: null,
    });
    expect(database.inTransaction).toBe(false);
  });

  it("rejects an unknown message before inserting a run", () => {
    const database = testDatabase();

    try {
      createProcessingRun(processingInput({ messageId: "inb-999" }), database);
      throw new Error("Expected missing message to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe("MESSAGE_NOT_FOUND");
    }
  });

  it("enforces at most one processing run per message", () => {
    const database = testDatabase();
    createProcessingRun(processingInput(), database);

    try {
      createProcessingRun(processingInput(), database);
      throw new Error("Expected duplicate processing run to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe("PROCESSING_RUN_EXISTS");
    }
  });

  it("completes a successful run and exposes it as the latest result", () => {
    const database = testDatabase();
    const processing = createProcessingRun(processingInput(), database);

    const completed = completeRunSuccess(
      processing.id,
      {
        status: "succeeded",
        result: {
          summary: "A prospective client needs post-liquidity planning.",
          category: "prospect",
          priority: "medium",
          suggestedNextAction:
            "Assign an advisor to schedule a discovery conversation.",
        },
        attemptCount: 2,
        inputTokens: 320,
        outputTokens: 72,
        durationMs: 1_240,
        now: new Date("2026-07-21T00:00:02.000Z"),
      },
      database,
    );

    expect(completed).toMatchObject({
      status: "succeeded",
      category: "prospect",
      priority: "medium",
      attemptCount: 2,
      inputTokens: 320,
      outputTokens: 72,
      durationMs: 1_240,
      completedAt: "2026-07-21T00:00:02.000Z",
    });
    expect(
      listMessageViews(database).find((message) => message.id === "inb-001")
        ?.latestRun,
    ).toEqual(completed);
  });

  it("persists a needs-review result without discarding model output", () => {
    const database = testDatabase();
    const processing = createProcessingRun(
      processingInput({
        messageId: "inb-010",
        inputQuality: "malformed",
        reviewReasons: [
          "near_empty",
          "missing_sender",
          "missing_subject",
          "unknown_organization",
          "low_context",
        ],
      }),
      database,
    );

    const completed = completeRunSuccess(
      processing.id,
      {
        status: "needs_review",
        result: {
          summary: "The submission contains no actionable context.",
          category: "unknown",
          priority: "low",
          suggestedNextAction: "Review manually or request more information.",
        },
      },
      database,
    );

    expect(completed.status).toBe("needs_review");
    expect(completed.inputQuality).toBe("malformed");
    expect(completed.category).toBe("unknown");
  });

  it("completes a failed run with a safe error and no result fields", () => {
    const database = testDatabase();
    const processing = createProcessingRun(processingInput(), database);

    const failed = completeRunFailure(
      processing.id,
      {
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "The provider did not respond in time. Please retry.",
        durationMs: 25_000,
        now: new Date("2026-07-21T00:00:25.000Z"),
      },
      database,
    );

    expect(failed).toMatchObject({
      status: "failed",
      summary: null,
      category: null,
      priority: null,
      errorCode: "PROVIDER_TIMEOUT",
      durationMs: 25_000,
    });
  });

  it("keeps completed attempts immutable and permits a new attempt", () => {
    const database = testDatabase();
    const first = createProcessingRun(processingInput(), database);
    completeRunFailure(
      first.id,
      {
        errorCode: "RATE_LIMITED",
        errorMessage: "The provider is busy. Please retry.",
        now: new Date("2026-07-21T00:00:01.000Z"),
      },
      database,
    );

    try {
      completeRunFailure(
        first.id,
        {
          errorCode: "OTHER",
          errorMessage: "A second completion should not be accepted.",
        },
        database,
      );
      throw new Error("Expected terminal update to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe("INVALID_RUN_TRANSITION");
    }

    const second = createProcessingRun(
      processingInput({ now: new Date("2026-07-21T00:01:00.000Z") }),
      database,
    );
    expect(second.id).toBeGreaterThan(first.id);
    expect(
      listMessageViews(database).find((message) => message.id === "inb-001")
        ?.latestRun?.id,
    ).toBe(second.id);
  });

  it("uses insertion order for the latest run when the wall clock moves backward", () => {
    const database = testDatabase();
    const first = createProcessingRun(
      processingInput({ now: new Date("2026-07-21T10:00:00.000Z") }),
      database,
    );
    completeRunFailure(
      first.id,
      {
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "The provider did not respond in time. Please retry.",
        now: new Date("2026-07-21T10:00:01.000Z"),
      },
      database,
    );

    const second = createProcessingRun(
      processingInput({ now: new Date("2026-07-21T09:00:00.000Z") }),
      database,
    );

    expect(
      listMessageViews(database).find((message) => message.id === "inb-001")
        ?.latestRun?.id,
    ).toBe(second.id);
  });
});

describe("stale processing recovery", () => {
  it("turns an interrupted processing run into a retryable failure", () => {
    const database = testDatabase();
    const processing = createProcessingRun(
      processingInput({ now: new Date("2026-07-21T00:00:00.000Z") }),
      database,
    );

    const recovered = recoverStaleProcessingRuns(
      {
        olderThanMs: 5 * 60 * 1_000,
        now: new Date("2026-07-21T00:06:00.000Z"),
      },
      database,
    );

    expect(recovered).toBe(1);
    expect(
      listMessageViews(database).find((message) => message.id === "inb-001")
        ?.latestRun,
    ).toMatchObject({
      id: processing.id,
      status: "failed",
      errorCode: "PROCESS_INTERRUPTED",
      completedAt: "2026-07-21T00:06:00.000Z",
    });
  });

  it("recovers stale runs during initialization", () => {
    const database = testDatabase();
    createProcessingRun(
      processingInput({ now: new Date("2026-07-21T00:00:00.000Z") }),
      database,
    );

    initializeDb({
      database,
      recoverStaleAfterMs: 5 * 60 * 1_000,
      now: new Date("2026-07-21T00:10:00.000Z"),
    });

    expect(
      listMessageViews(database).find((message) => message.id === "inb-001")
        ?.latestRun?.status,
    ).toBe("failed");
  });

  it("rejects unsafe recovery windows", () => {
    const database = testDatabase();

    expect(() =>
      recoverStaleProcessingRuns({ olderThanMs: 1_000 }, database),
    ).toThrow(RangeError);
    expect(() =>
      recoverStaleProcessingRuns(
        { olderThanMs: 24 * 60 * 60 * 1_000 + 1 },
        database,
      ),
    ).toThrow(RangeError);
  });
});
