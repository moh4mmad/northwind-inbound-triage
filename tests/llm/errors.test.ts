import { describe, expect, it } from "vitest";
import { ProviderError, toProviderError, toSafeError } from "@/lib/llm/errors";

describe("toProviderError", () => {
  it.each([
    [{ status: 401 }, "authentication", false],
    [
      { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } },
      "permission_denied",
      false,
    ],
    [{ status: 429 }, "rate_limit", true],
    [{ name: "ModelTimeoutException" }, "timeout", true],
    [{ name: "ServiceUnavailableException" }, "provider_unavailable", true],
    [{ name: "ValidationException" }, "configuration", false],
    [{ name: "CredentialsProviderError" }, "configuration", false],
    [{ name: "TokenProviderError" }, "authentication", false],
    [{ name: "APIConnectionError" }, "network", true],
  ] as const)("normalizes provider failures", (source, code, retryable) => {
    expect(toProviderError(source, "bedrock")).toMatchObject({
      code,
      retryable,
      provider: "bedrock",
    });
  });

  it("preserves normalized provider errors", () => {
    const original = new ProviderError("invalid_output", "openai");
    expect(toProviderError(original, "openai")).toBe(original);
  });

  it.each([
    [new AnthropicTimeoutError(), "anthropic", "timeout", true],
    [new OpenAITimeoutError(), "openai", "timeout", true],
    [
      new AnthropicConnectionError({ cause: new Error("socket") }),
      "anthropic",
      "network",
      true,
    ],
    [
      new OpenAIConnectionError({ cause: new Error("socket") }),
      "openai",
      "network",
      true,
    ],
    [new AnthropicAbortError(), "anthropic", "cancelled", false],
    [new OpenAIAbortError(), "openai", "cancelled", false],
  ] as const)(
    "recognizes installed SDK subclasses whose error.name is generic",
    (source, provider, code, retryable) => {
      expect(toProviderError(source, provider)).toMatchObject({
        code,
        retryable,
        provider,
      });
    },
  );
});

describe("toSafeError", () => {
  it("never exposes an unknown error message", () => {
    const safe = toSafeError(
      new Error("sk-live-secret and raw provider response"),
    );
    expect(safe).toEqual({
      code: "unknown",
      message: "The AI provider request failed.",
      retryable: false,
    });
    expect(safe.message).not.toContain("secret");
  });
});
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIUserAbortError as AnthropicAbortError,
} from "@anthropic-ai/sdk";
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIUserAbortError as OpenAIAbortError,
} from "openai";
