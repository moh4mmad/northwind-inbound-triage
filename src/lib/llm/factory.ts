import "server-only";

import type { RuntimeConfig } from "@/lib/config/env";
import { AnthropicTriageProvider, type AnthropicClientLike } from "./anthropic";
import { BedrockTriageProvider, type BedrockClientLike } from "./bedrock";
import { providerError } from "./errors";
import { OpenAITriageProvider, type OpenAIClientLike } from "./openai";
import type { TriageProvider } from "./types";

export type ProviderFactoryConfig = Pick<
  RuntimeConfig,
  "provider" | "model" | "configured" | "apiKey" | "awsRegion" | "timeoutMs"
>;

export interface ProviderFactoryDependencies {
  anthropicClient?: AnthropicClientLike;
  openAIClient?: OpenAIClientLike;
  bedrockClient?: BedrockClientLike;
}

export function createTriageProvider(
  config: ProviderFactoryConfig,
  dependencies: ProviderFactoryDependencies = {},
): TriageProvider {
  if (!config.configured) {
    throw providerError("configuration", config.provider);
  }

  if (config.provider === "anthropic") {
    return new AnthropicTriageProvider(
      {
        apiKey: requireValue(config.apiKey, config.provider),
        model: config.model,
        timeoutMs: config.timeoutMs,
      },
      dependencies.anthropicClient,
    );
  }

  if (config.provider === "openai") {
    return new OpenAITriageProvider(
      {
        apiKey: requireValue(config.apiKey, config.provider),
        model: config.model,
        timeoutMs: config.timeoutMs,
      },
      dependencies.openAIClient,
    );
  }

  return new BedrockTriageProvider(
    {
      region: requireValue(config.awsRegion, config.provider),
      model: requireValue(config.model, config.provider),
      timeoutMs: config.timeoutMs,
    },
    dependencies.bedrockClient,
  );
}

function requireValue(
  value: string | undefined,
  provider: ProviderFactoryConfig["provider"],
): string {
  if (
    !value ||
    value.trim().length === 0 ||
    value === "Bedrock model not configured"
  ) {
    throw providerError("configuration", provider);
  }
  return value.trim();
}
