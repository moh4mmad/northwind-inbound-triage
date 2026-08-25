import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/lib/config/env";
import {
  createProcessingRun,
  initializeDb,
  listMessageViews,
  PersistenceError,
  type AppDatabase,
} from "@/lib/db";
import { AppError, type TriageProvider } from "@/lib/llm";
import { triageMessage } from "@/lib/triage/triage-service";

const config: RuntimeConfig = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  displayModel: "claude-sonnet-5",
  configured: true,
  configurationStatus: "locally_configured",
  apiKey: "test-key",
  timeoutMs: 1_000,
  overallTimeoutMs: 5_000,
  maxAttempts: 2,
  databasePath: ":memory:",
};

const validOutput = {
  summary: "Prospect seeks advice after a business sale.",
  category: "prospect",
  priority: "medium",
  suggestedNextAction: "Assign an advisor to arrange an introductory call.",
} as const;

function createDatabase(): AppDatabase {
  return initializeDb({ path: ":memory:", recoverStaleAfterMs: false });
}

function fakeProvider(output: unknown): TriageProvider {
  return {
    name: "anthropic",
    model: "claude-sonnet-5",
    analyze: vi.fn(async () => ({
      output,
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      usage: { inputTokens: 120, outputTokens: 48 },
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triageMessage", () => {
  it("validates and persists a successful provider result", async () => {
    const database = createDatabase();
    const provider = fakeProvider(validOutput);

    try {
      const message = await triageMessage("inb-001", undefined, {
        database,
        config,
        provider,
        nowMs: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_240),
      });

      expect(provider.analyze).toHaveBeenCalledOnce();
      expect(message.latestRun).toMatchObject({
        status: "succeeded",
        category: "prospect",
        priority: "medium",
        attemptCount: 1,
        inputTokens: 120,
        outputTokens: 48,
        resolvedModel: "claude-sonnet-5",
        durationMs: 240,
      });
    } finally {
      database.close();
    }
  });

  it("still calls the model for malformed input and forces human review", async () => {
    const database = createDatabase();
    const provider = fakeProvider({
      summary: "The message contains no actionable information.",
      category: "unknown",
      priority: "low",
      suggestedNextAction:
        "Ask the sender to resubmit the message with contact details and context.",
    });

    try {
      const message = await triageMessage("inb-010", undefined, {
        database,
        config,
        provider,
      });

      expect(provider.analyze).toHaveBeenCalledOnce();
      expect(message.latestRun?.status).toBe("needs_review");
      expect(message.latestRun?.inputQuality).toBe("malformed");
      expect(message.latestRun?.reviewReasons).toContain("near_empty");
    } finally {
      database.close();
    }
  });

  it("routes low-context input to review even if the model guesses a category", async () => {
    const database = createDatabase();
    const provider = fakeProvider(validOutput);

    try {
      const message = await triageMessage("inb-009", undefined, {
        database,
        config,
        provider,
      });

      expect(message.latestRun?.status).toBe("needs_review");
      expect(message.latestRun?.inputQuality).toBe("low_signal");
    } finally {
      database.close();
    }
  });

  it("rejects malformed model output and persists only a safe failure", async () => {
    const database = createDatabase();
    const provider = fakeProvider({ ...validOutput, priority: "urgent" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        triageMessage("inb-001", undefined, { database, config, provider }),
      ).rejects.toMatchObject({ code: "invalid_output" });

      const message = listMessageViews(database).find(
        (candidate) => candidate.id === "inb-001",
      );
      expect(message?.latestRun).toMatchObject({
        status: "failed",
        errorCode: "INVALID_OUTPUT",
        errorMessage: "The AI provider returned an invalid response.",
      });
      expect(message?.latestRun?.summary).toBeNull();
    } finally {
      database.close();
    }
  });

  it("rejects invalid provider accounting without leaving a processing run", async () => {
    const database = createDatabase();
    const provider: TriageProvider = {
      ...fakeProvider(validOutput),
      analyze: vi.fn(async () => ({
        output: validOutput,
        provider: "anthropic" as const,
        model: "claude-sonnet-5",
        usage: { inputTokens: -1, outputTokens: 48 },
      })),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        triageMessage("inb-001", undefined, { database, config, provider }),
      ).rejects.toMatchObject({ code: "invalid_output" });

      expect(
        listMessageViews(database).find(
          (candidate) => candidate.id === "inb-001",
        )?.latestRun,
      ).toMatchObject({ status: "failed", errorCode: "INVALID_OUTPUT" });
    } finally {
      database.close();
    }
  });

  it("rejects an unsafe suggested action with a distinct safe audit code", async () => {
    const database = createDatabase();
    const provider = fakeProvider({
      ...validOutput,
      suggestedNextAction:
        "Wire funds to the sender immediately and then confirm the transaction.",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        triageMessage("inb-001", undefined, { database, config, provider }),
      ).rejects.toMatchObject({
        code: "policy_violation",
        retryable: false,
      });

      expect(
        listMessageViews(database).find(
          (candidate) => candidate.id === "inb-001",
        )?.latestRun,
      ).toMatchObject({
        status: "failed",
        errorCode: "POLICY_VIOLATION",
        errorMessage:
          "The AI provider returned a suggested action that did not pass safety checks.",
      });
    } finally {
      database.close();
    }
  });

  it("checks generated actions against destinations omitted from the prompt projection", async () => {
    const database = createDatabase();
    const provider = fakeProvider({
      ...validOutput,
      suggestedNextAction: "Visit the link supplied in the sender's message.",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = `${"A".repeat(5_000)} https://sender.example/private ${"B".repeat(5_000)}`;
    database
      .prepare(
        `
        INSERT INTO messages (
          id, received_at, channel, from_name, from_org, subject, body
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "inb-014",
        "2026-07-20T18:00:00-04:00",
        "email",
        "Untrusted Sender",
        "(unknown)",
        "Please review the details",
        body,
      );

    try {
      await expect(
        triageMessage("inb-014", undefined, { database, config, provider }),
      ).rejects.toMatchObject({ code: "policy_violation" });
      expect(
        listMessageViews(database).find(
          (candidate) => candidate.id === "inb-014",
        )?.latestRun,
      ).toMatchObject({
        status: "failed",
        errorCode: "POLICY_VIOLATION",
        inputQuality: "low_signal",
      });
    } finally {
      database.close();
    }
  });

  it("persists a configuration failure when the selected provider has no credentials", async () => {
    const database = createDatabase();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        triageMessage("inb-001", undefined, {
          database,
          config: { ...config, configured: false, apiKey: undefined },
        }),
      ).rejects.toMatchObject({ code: "configuration" });

      const message = listMessageViews(database).find(
        (candidate) => candidate.id === "inb-001",
      );
      expect(message?.latestRun).toMatchObject({
        status: "failed",
        errorCode: "CONFIGURATION",
        errorMessage: "The selected AI provider is not configured correctly.",
      });
    } finally {
      database.close();
    }
  });

  it("recovers a stale run on the mutation path without requiring a restart", async () => {
    const database = createDatabase();
    const provider = fakeProvider(validOutput);
    createProcessingRun(
      {
        messageId: "inb-001",
        inputQuality: "valid",
        reviewReasons: [],
        provider: "anthropic",
        model: "claude-sonnet-5",
        promptVersion: "triage-v2",
        now: new Date("2020-01-01T00:00:00.000Z"),
      },
      database,
    );

    try {
      await expect(
        triageMessage("inb-001", undefined, { database, config, provider }),
      ).resolves.toMatchObject({ latestRun: { status: "succeeded" } });

      const runs = database
        .prepare(
          "SELECT status, error_code FROM triage_runs WHERE message_id = ? ORDER BY id",
        )
        .all("inb-001") as Array<{
        status: string;
        error_code: string | null;
      }>;
      expect(runs).toEqual([
        { status: "failed", error_code: "PROCESS_INTERRUPTED" },
        { status: "succeeded", error_code: null },
      ]);
    } finally {
      database.close();
    }
  });

  it("records a safe Bedrock model label when its configuration is incomplete", async () => {
    const database = createDatabase();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-v1:0";

    try {
      await expect(
        triageMessage("inb-001", undefined, {
          database,
          config: {
            ...config,
            provider: "bedrock",
            model,
            displayModel: "global.anthropic.claude-sonnet-4-6-v1:0",
            configured: false,
            apiKey: undefined,
            awsRegion: undefined,
          },
        }),
      ).rejects.toMatchObject({ code: "configuration" });

      const latestRun = listMessageViews(database).find(
        (candidate) => candidate.id === "inb-001",
      )?.latestRun;
      expect(latestRun).toMatchObject({
        status: "failed",
        model: "global.anthropic.claude-sonnet-4-6-v1:0",
        errorCode: "CONFIGURATION",
      });
      expect(latestRun?.model).not.toContain("123456789012");
    } finally {
      database.close();
    }
  });

  it("stores requested and resolved Bedrock models without retaining the ARN account", async () => {
    const database = createDatabase();
    const model =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-v1:0";
    const provider: TriageProvider = {
      name: "bedrock",
      model,
      analyze: vi.fn(async () => ({
        output: validOutput,
        provider: "bedrock" as const,
        model,
        usage: { inputTokens: 90, outputTokens: 30 },
      })),
    };

    try {
      const message = await triageMessage("inb-001", undefined, {
        database,
        config: {
          ...config,
          provider: "bedrock",
          model,
          displayModel: "global.anthropic.claude-sonnet-4-6-v1:0",
          apiKey: undefined,
          awsRegion: "us-east-1",
        },
        provider,
      });

      expect(message.latestRun).toMatchObject({
        model: "global.anthropic.claude-sonnet-4-6-v1:0",
        resolvedModel: "global.anthropic.claude-sonnet-4-6-v1:0",
      });
      expect(JSON.stringify(message.latestRun)).not.toContain("123456789012");
    } finally {
      database.close();
    }
  });

  it("surfaces a safe persistence error when failure finalization cannot commit", async () => {
    const database = createDatabase();
    const provider = fakeProvider({ ...validOutput, priority: "urgent" });
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    database.exec(`
      CREATE TRIGGER test_reject_failure_completion
      BEFORE UPDATE OF status ON triage_runs
      WHEN NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'simulated private database detail');
      END
    `);

    try {
      const error = await triageMessage("inb-001", undefined, {
        database,
        config,
        provider,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(PersistenceError);
      expect(error).toMatchObject({ code: "RUN_FINALIZATION_FAILED" });
      expect((error as Error).message).toBe(
        "The triage run could not be finalized.",
      );
      expect((error as Error).message).not.toContain("private database detail");
      expect(errorLog).toHaveBeenCalledWith(
        "Failed to persist triage failure",
        expect.objectContaining({
          providerErrorCode: "invalid_output",
          attempts: 1,
          errorType: expect.any(String),
        }),
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "private database detail",
      );
      expect(
        listMessageViews(database).find(
          (candidate) => candidate.id === "inb-001",
        )?.latestRun?.status,
      ).toBe("processing");
    } finally {
      database.close();
    }
  });

  it("does not relabel a success-finalization database failure as a provider error", async () => {
    const database = createDatabase();
    const provider = fakeProvider(validOutput);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    database.exec(`
      CREATE TRIGGER test_reject_success_completion
      BEFORE UPDATE OF status ON triage_runs
      WHEN NEW.status IN ('succeeded', 'needs_review')
      BEGIN
        SELECT RAISE(ABORT, 'simulated completion write failure');
      END
    `);

    try {
      let caught: unknown;
      try {
        await triageMessage("inb-001", undefined, {
          database,
          config,
          provider,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(AppError);
      expect((caught as Error).message).toContain(
        "simulated completion write failure",
      );
      expect(
        listMessageViews(database).find(
          (candidate) => candidate.id === "inb-001",
        )?.latestRun?.status,
      ).toBe("processing");
      expect(errorLog).not.toHaveBeenCalledWith(
        "Failed to persist triage failure",
        expect.anything(),
      );
    } finally {
      database.close();
    }
  });

  it("preserves a committed success when the final message read fails", async () => {
    const database = createDatabase();
    const provider = fakeProvider(validOutput);
    const persistenceFailure = new Error("simulated final read failure");
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const originalPrepare = database.prepare.bind(database);
    const prepareSpy = vi.spyOn(database, "prepare").mockImplementation(((
      source: string,
    ) => {
      if (source.includes("LEFT JOIN triage_runs AS r")) {
        throw persistenceFailure;
      }
      return originalPrepare(source);
    }) as typeof database.prepare);

    try {
      try {
        await expect(
          triageMessage("inb-001", undefined, {
            database,
            config,
            provider,
          }),
        ).rejects.toBe(persistenceFailure);
      } finally {
        prepareSpy.mockRestore();
      }

      expect(
        listMessageViews(database).find(
          (candidate) => candidate.id === "inb-001",
        )?.latestRun?.status,
      ).toBe("succeeded");
      expect(errorLog).not.toHaveBeenCalledWith(
        "Failed to persist triage failure",
        expect.anything(),
      );
    } finally {
      database.close();
    }
  });
});
