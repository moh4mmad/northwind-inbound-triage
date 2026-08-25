import "server-only";

import { z } from "zod";
import { PROVIDER_KEYS, type ProviderName } from "@/lib/domain/taxonomy";
import {
  DEFAULT_PROVIDER_OVERALL_TIMEOUT_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MAX_PROVIDER_ATTEMPTS,
  MAX_PROVIDER_ATTEMPT_TIMEOUT_MS,
  MAX_PROVIDER_OVERALL_TIMEOUT_MS,
} from "@/lib/llm/limits";
import {
  sanitizeModelForDisplay,
  supportsAnthropicStructuredTriage,
  supportsBedrockStructuredTriage,
  supportsOpenAIStructuredTriage,
} from "@/lib/llm/model-capabilities";

const providerSchema = z.enum(PROVIDER_KEYS);
const boundedInteger = (fallback: number, minimum: number, maximum: number) =>
  z.coerce
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .optional()
    .transform((value) => value ?? fallback);

const MIN_PROVIDER_TIMEOUT_MS = 1_000;

export interface RuntimeConfig {
  provider: ProviderName;
  /** Server-only model or inference-profile identifier used for invocation. */
  model: string;
  /** Safe model label suitable for logs, persistence, and API responses. */
  displayModel: string;
  /** Local environment validation only; provider access is verified on invocation. */
  configured: boolean;
  configurationStatus: "locally_configured" | "not_configured";
  apiKey?: string;
  awsRegion?: string;
  timeoutMs: number;
  overallTimeoutMs: number;
  maxAttempts: number;
  databasePath: string;
}

interface ProviderDetails {
  name: ProviderName;
  model: string;
  displayModel: string;
  configured: boolean;
  configurationStatus: "locally_configured" | "not_configured";
  apiKey?: string;
  awsRegion?: string;
}

function readProviderDetails(): ProviderDetails {
  const provider = providerSchema.parse(
    process.env.LLM_PROVIDER?.trim() || "anthropic",
  );

  if (provider === "anthropic") {
    const model = (process.env.ANTHROPIC_MODEL || "claude-sonnet-5").trim();
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    const supportedModel = supportsAnthropicStructuredTriage(model);
    const configured = Boolean(apiKey && supportedModel);
    return {
      name: provider,
      model,
      displayModel: supportedModel
        ? model
        : "Unsupported Anthropic model for structured triage",
      configured,
      configurationStatus: configured ? "locally_configured" : "not_configured",
      apiKey,
    };
  }

  if (provider === "openai") {
    const model = (process.env.OPENAI_MODEL || "gpt-5.6-terra").trim();
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const supportedModel = supportsOpenAIStructuredTriage(model);
    const configured = Boolean(apiKey && supportedModel);
    return {
      name: provider,
      model,
      displayModel: supportedModel
        ? model
        : "Unsupported OpenAI model for structured triage",
      configured,
      configurationStatus: configured ? "locally_configured" : "not_configured",
      apiKey,
    };
  }

  const model = (process.env.BEDROCK_MODEL_ID || "").trim();
  const awsRegion = process.env.AWS_REGION?.trim();
  const supportedModel = supportsBedrockStructuredTriage(model);
  const configured = Boolean(awsRegion && supportedModel);
  return {
    name: provider,
    model,
    displayModel: supportedModel
      ? sanitizeModelForDisplay(provider, model)
      : model
        ? "Unsupported Bedrock Converse structured-output model"
        : "Bedrock model not configured",
    configured,
    configurationStatus: configured ? "locally_configured" : "not_configured",
    awsRegion,
  };
}

export function getProviderSelection(): {
  name: ProviderName;
  model: string;
  configured: boolean;
  configurationStatus: "locally_configured" | "not_configured";
} {
  const details = readProviderDetails();
  return {
    name: details.name,
    model: details.displayModel,
    configured: details.configured,
    configurationStatus: details.configurationStatus,
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const details = readProviderDetails();
  const providerTimeoutKey = `${details.name.toUpperCase()}_TIMEOUT_MS`;
  const timeoutMs = boundedInteger(
    DEFAULT_PROVIDER_TIMEOUT_MS[details.name],
    MIN_PROVIDER_TIMEOUT_MS,
    MAX_PROVIDER_ATTEMPT_TIMEOUT_MS,
  ).parse(process.env[providerTimeoutKey] ?? process.env.LLM_TIMEOUT_MS);
  const overallTimeoutMs = boundedInteger(
    DEFAULT_PROVIDER_OVERALL_TIMEOUT_MS,
    MIN_PROVIDER_TIMEOUT_MS,
    MAX_PROVIDER_OVERALL_TIMEOUT_MS,
  ).parse(process.env.LLM_OVERALL_TIMEOUT_MS);
  const maxAttempts = boundedInteger(2, 1, MAX_PROVIDER_ATTEMPTS).parse(
    process.env.LLM_MAX_ATTEMPTS,
  );

  if (overallTimeoutMs < timeoutMs) {
    throw new RangeError(
      "LLM_OVERALL_TIMEOUT_MS must be greater than or equal to the selected provider timeout",
    );
  }

  const common = {
    provider: details.name,
    model: details.model,
    displayModel: details.displayModel,
    configured: details.configured,
    configurationStatus: details.configurationStatus,
    timeoutMs,
    overallTimeoutMs,
    maxAttempts,
    databasePath: process.env.DATABASE_PATH || "./data/triage.sqlite",
  };

  if (details.name === "anthropic") {
    return { ...common, apiKey: details.apiKey };
  }
  if (details.name === "openai") {
    return { ...common, apiKey: details.apiKey };
  }
  return { ...common, awsRegion: details.awsRegion };
}
