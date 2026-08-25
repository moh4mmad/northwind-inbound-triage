import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderSelection, getRuntimeConfig } from "@/lib/config/env";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "LLM_TIMEOUT_MS",
  "ANTHROPIC_TIMEOUT_MS",
  "OPENAI_TIMEOUT_MS",
  "BEDROCK_TIMEOUT_MS",
  "LLM_OVERALL_TIMEOUT_MS",
  "LLM_MAX_ATTEMPTS",
] as const;

const originalValues = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  ENV_KEYS.forEach((key) => delete process.env[key]);
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    const original = originalValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
});

describe("provider environment", () => {
  it("defaults to direct Anthropic Sonnet 5", () => {
    expect(getProviderSelection()).toEqual({
      name: "anthropic",
      model: "claude-sonnet-5",
      configured: false,
      configurationStatus: "not_configured",
    });
  });

  it("validates only the selected provider's credentials", () => {
    process.env.LLM_PROVIDER = "  openai  ";
    process.env.OPENAI_API_KEY = "test-openai-key";

    expect(getRuntimeConfig()).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-terra",
      displayModel: "gpt-5.6-terra",
      configured: true,
      configurationStatus: "locally_configured",
      apiKey: "test-openai-key",
      timeoutMs: 30_000,
      overallTimeoutMs: 240_000,
    });
  });

  it("does not expose an invalid cross-provider Anthropic model value", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.ANTHROPIC_MODEL =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/example";

    expect(getProviderSelection()).toEqual({
      name: "anthropic",
      model: "Unsupported Anthropic model for structured triage",
      configured: false,
      configurationStatus: "not_configured",
    });
  });

  it("shows a Bedrock profile name without exposing the surrounding ARN", () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-20260801-v1:0";

    expect(getProviderSelection()).toEqual({
      name: "bedrock",
      model: "global.anthropic.claude-sonnet-4-6-20260801-v1:0",
      configured: true,
      configurationStatus: "locally_configured",
    });

    expect(getRuntimeConfig()).toMatchObject({
      model:
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-20260801-v1:0",
      displayModel: "global.anthropic.claude-sonnet-4-6-20260801-v1:0",
      timeoutMs: 180_000,
    });
  });

  it("treats a blank Bedrock model as safely unconfigured", () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID = "   ";

    expect(getProviderSelection()).toEqual({
      name: "bedrock",
      model: "Bedrock model not configured",
      configured: false,
      configurationStatus: "not_configured",
    });
  });

  it("trims credentials and provider configuration values", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "  test-openai-key  ";
    process.env.OPENAI_MODEL = "  gpt-5.6-terra  ";

    expect(getRuntimeConfig()).toMatchObject({
      apiKey: "test-openai-key",
      model: "gpt-5.6-terra",
      configured: true,
    });
  });

  it("requires a model supported by the selected structured-output API", () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-5";

    expect(getProviderSelection()).toEqual({
      name: "bedrock",
      model: "Unsupported Bedrock Converse structured-output model",
      configured: false,
      configurationStatus: "not_configured",
    });
  });

  it("uses provider-specific timeout overrides with a bounded overall deadline", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_TIMEOUT_MS = "12000";
    process.env.OPENAI_TIMEOUT_MS = "45000";
    process.env.LLM_OVERALL_TIMEOUT_MS = "90000";
    process.env.LLM_MAX_ATTEMPTS = "3";

    expect(getRuntimeConfig()).toMatchObject({
      timeoutMs: 45_000,
      overallTimeoutMs: 90_000,
      maxAttempts: 3,
    });
  });

  it.each([
    ["LLM_MAX_ATTEMPTS", "4"],
    ["OPENAI_TIMEOUT_MS", "180001"],
    ["LLM_OVERALL_TIMEOUT_MS", "240001"],
  ] as const)("rejects an unsafe %s setting", (key, value) => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env[key] = value;

    expect(() => getRuntimeConfig()).toThrow();
  });

  it("rejects an overall deadline shorter than an attempt timeout", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_TIMEOUT_MS = "60000";
    process.env.LLM_OVERALL_TIMEOUT_MS = "30000";

    expect(() => getRuntimeConfig()).toThrow(RangeError);
  });

  it("rejects an unknown provider instead of silently defaulting", () => {
    process.env.LLM_PROVIDER = "mystery";
    expect(() => getProviderSelection()).toThrow();
  });
});
