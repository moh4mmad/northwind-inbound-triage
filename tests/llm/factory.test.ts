import { describe, expect, it, vi } from "vitest";
import type { AnthropicClientLike } from "@/lib/llm/anthropic";
import type { BedrockClientLike } from "@/lib/llm/bedrock";
import {
  createTriageProvider,
  type ProviderFactoryConfig,
} from "@/lib/llm/factory";
import type { OpenAIClientLike } from "@/lib/llm/openai";

const baseConfig = {
  configured: true,
  apiKey: "test-key",
  awsRegion: "us-east-1",
  timeoutMs: 1_000,
} as const;

const dependencies = {
  anthropicClient: {
    messages: { create: vi.fn() },
  } as unknown as AnthropicClientLike,
  openAIClient: {
    responses: { create: vi.fn() },
  } as unknown as OpenAIClientLike,
  bedrockClient: { send: vi.fn() } as unknown as BedrockClientLike,
};

describe("createTriageProvider", () => {
  it.each([
    ["anthropic", "claude-sonnet-5"],
    ["openai", "gpt-5.6-terra"],
    ["bedrock", "anthropic.claude-sonnet-4-6-v1:0"],
  ] as const)("creates only the configured %s adapter", (provider, model) => {
    const config: ProviderFactoryConfig = { ...baseConfig, provider, model };
    expect(createTriageProvider(config, dependencies)).toMatchObject({
      name: provider,
      model,
    });
  });

  it("fails safely when the selected provider is not configured", () => {
    const config: ProviderFactoryConfig = {
      ...baseConfig,
      provider: "anthropic",
      model: "claude-sonnet-5",
      configured: false,
      apiKey: undefined,
    };

    expect(() => createTriageProvider(config, dependencies)).toThrowError(
      expect.objectContaining({ code: "configuration", provider: "anthropic" }),
    );
  });
});
