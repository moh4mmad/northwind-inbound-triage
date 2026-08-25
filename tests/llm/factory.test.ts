import { describe, expect, it, vi } from "vitest";
import type { AnthropicClientLike } from "@/lib/llm/anthropic";
import type { BedrockClientLike } from "@/lib/llm/bedrock";
import {
  createTriageProvider,
  type ProviderFactoryConfig,
} from "@/lib/llm/factory";
import type { OpenAIClientLike } from "@/lib/llm/openai";

const baseConfig = {
  model: "test-model",
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
  it.each(["anthropic", "openai", "bedrock"] as const)(
    "creates only the configured %s adapter",
    (provider) => {
      const config: ProviderFactoryConfig = { ...baseConfig, provider };
      expect(createTriageProvider(config, dependencies)).toMatchObject({
        name: provider,
        model: "test-model",
      });
    },
  );

  it("fails safely when the selected provider is not configured", () => {
    const config: ProviderFactoryConfig = {
      ...baseConfig,
      provider: "anthropic",
      configured: false,
      apiKey: undefined,
    };

    expect(() => createTriageProvider(config, dependencies)).toThrowError(
      expect.objectContaining({ code: "configuration", provider: "anthropic" }),
    );
  });
});
