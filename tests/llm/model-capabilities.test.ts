import { describe, expect, it } from "vitest";
import {
  openAIReasoningEffort,
  sanitizeModelForDisplay,
  supportsAnthropicStructuredTriage,
  supportsBedrockStructuredTriage,
  supportsOpenAIStructuredTriage,
} from "@/lib/llm/model-capabilities";

describe("provider model capabilities", () => {
  it.each([
    "claude-sonnet-5",
    "claude-sonnet-5-20260801",
    "claude-sonnet-4-6",
    "claude-opus-4-7-20260801",
  ])("accepts supported direct Anthropic model %s", (model) => {
    expect(supportsAnthropicStructuredTriage(model)).toBe(true);
  });

  it.each([
    "claude-3-5-sonnet-latest",
    "anthropic.claude-sonnet-5",
    "global.anthropic.claude-sonnet-5",
    "",
  ])("rejects unsupported direct Anthropic model %s", (model) => {
    expect(supportsAnthropicStructuredTriage(model)).toBe(false);
  });

  it.each(["gpt-5.6-terra", "gpt-5-mini", "gpt-4o-mini", "gpt-4.1-nano"])(
    "accepts supported OpenAI structured-output model %s",
    (model) => {
      expect(supportsOpenAIStructuredTriage(model)).toBe(true);
    },
  );

  it("only requests none reasoning effort for the verified GPT-5.6 family", () => {
    expect(openAIReasoningEffort("gpt-5.6-terra")).toBe("none");
    expect(openAIReasoningEffort("gpt-5-mini")).toBeUndefined();
    expect(openAIReasoningEffort("gpt-4o-mini")).toBeUndefined();
  });

  it.each([
    "anthropic.claude-sonnet-4-6-20260801-v1:0",
    "global.anthropic.claude-sonnet-4-6-20260801-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "eu.anthropic.claude-opus-4-5-v1:0",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-6-20260801-v1:0",
  ])("accepts Bedrock Converse structured-output model %s", (model) => {
    expect(supportsBedrockStructuredTriage(model)).toBe(true);
  });

  it.each([
    "global.anthropic.claude-sonnet-5-20260801-v1:0",
    "anthropic.claude-opus-4-7-v1:0",
    "amazon.nova-pro-v1:0",
    "claude-sonnet-5",
  ])("rejects model unsupported by Bedrock Converse %s", (model) => {
    expect(supportsBedrockStructuredTriage(model)).toBe(false);
  });

  it("removes the account-bearing ARN prefix from Bedrock display labels", () => {
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-v1:0";
    const display = sanitizeModelForDisplay("bedrock", arn);

    expect(display).toBe("global.anthropic.claude-sonnet-4-6-v1:0");
    expect(display).not.toContain("123456789012");
  });

  it("bounds and neutralizes provider-returned model labels before audit or logs", () => {
    const display = sanitizeModelForDisplay(
      "openai",
      `gpt-5.6-terra\nspoofed\u202E${"x".repeat(400)}`,
    );

    expect(display).toMatch(/^gpt-5\.6-terra�spoofed�x+$/u);
    expect(display).toHaveLength(300);
    expect(display).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  });
});
