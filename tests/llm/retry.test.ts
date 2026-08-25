import { describe, expect, it, vi } from "vitest";
import { providerError } from "@/lib/llm/errors";
import { analyzeWithRetry, withProviderRetry } from "@/lib/llm/retry";
import type { TriageProvider } from "@/lib/llm/types";

describe("withProviderRetry", () => {
  it("retries a transient error outside the SDK and reports the attempt count", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        providerError("rate_limit", "anthropic", { retryable: true }),
      )
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withProviderRetry(operation, {
        provider: "anthropic",
        maxAttempts: 2,
        timeoutMs: 1_000,
        baseDelayMs: 100,
        random: () => 0.5,
        sleep,
      }),
    ).resolves.toEqual({ value: "ok", attempts: 2 });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100, undefined);
  });

  it("does not retry invalid output", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(providerError("invalid_output", "openai"));

    await expect(
      withProviderRetry(operation, {
        provider: "openai",
        maxAttempts: 3,
        timeoutMs: 1_000,
        sleep: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "invalid_output", attempts: 1 });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("bounds an attempt even if the operation ignores the abort signal", async () => {
    const neverResolves = () => new Promise<never>(() => undefined);

    await expect(
      withProviderRetry(neverResolves, {
        provider: "bedrock",
        maxAttempts: 1,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true, attempts: 1 });
  });

  it("propagates caller cancellation without retrying", async () => {
    const controller = new AbortController();
    controller.abort("navigation");
    const operation = vi.fn();

    await expect(
      withProviderRetry(operation, {
        provider: "anthropic",
        maxAttempts: 2,
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "cancelled",
      retryable: false,
      attempts: 1,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects an invalid retry policy before calling the provider", async () => {
    const operation = vi.fn();

    await expect(
      withProviderRetry(operation, {
        provider: "openai",
        maxAttempts: 0,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("normalizes cancellation during retry backoff", async () => {
    const controller = new AbortController();
    const operation = vi
      .fn()
      .mockRejectedValue(
        providerError("provider_unavailable", "bedrock", { retryable: true }),
      );
    setTimeout(() => controller.abort("user left"), 5);

    await expect(
      withProviderRetry(operation, {
        provider: "bedrock",
        maxAttempts: 2,
        timeoutMs: 1_000,
        baseDelayMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled", attempts: 1 });
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("analyzeWithRetry", () => {
  it("passes a per-attempt signal to the selected provider", async () => {
    const analyze = vi.fn().mockResolvedValue({
      output: {},
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const provider: TriageProvider = {
      name: "anthropic",
      model: "claude-sonnet-5",
      analyze,
    };

    await expect(
      analyzeWithRetry(
        provider,
        { systemPrompt: "system", userPrompt: "user", schema: {} },
        { maxAttempts: 1, timeoutMs: 1_000 },
      ),
    ).resolves.toMatchObject({ attempts: 1 });

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
