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
    });
  });

  it("validates only the selected provider's credentials", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";

    expect(getRuntimeConfig()).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-terra",
      displayModel: "gpt-5.6-terra",
      configured: true,
      apiKey: "test-openai-key",
    });
  });

  it("does not expose an invalid cross-provider Anthropic model value", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.ANTHROPIC_MODEL =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/example";

    expect(getProviderSelection()).toEqual({
      name: "anthropic",
      model: "Invalid Anthropic model ID",
      configured: false,
    });
  });

  it("shows a Bedrock profile name without exposing the surrounding ARN", () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5";

    expect(getProviderSelection()).toEqual({
      name: "bedrock",
      model: "global.anthropic.claude-sonnet-5",
      configured: true,
    });

    expect(getRuntimeConfig()).toMatchObject({
      model:
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5",
      displayModel: "global.anthropic.claude-sonnet-5",
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
    });
  });

  it("rejects an unknown provider instead of silently defaulting", () => {
    process.env.LLM_PROVIDER = "mystery";
    expect(() => getProviderSelection()).toThrow();
  });
});
