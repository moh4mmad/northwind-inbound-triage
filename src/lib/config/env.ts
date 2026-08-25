import "server-only";

import { z } from "zod";
import { PROVIDER_KEYS, type ProviderName } from "@/lib/domain/taxonomy";

const providerSchema = z.enum(PROVIDER_KEYS);
const positiveInteger = (fallback: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((value) => value ?? fallback);

export interface RuntimeConfig {
  provider: ProviderName;
  /** Server-only model or inference-profile identifier used for invocation. */
  model: string;
  /** Safe model label suitable for logs, persistence, and API responses. */
  displayModel: string;
  configured: boolean;
  apiKey?: string;
  awsRegion?: string;
  timeoutMs: number;
  maxAttempts: number;
  databasePath: string;
}

interface ProviderDetails {
  name: ProviderName;
  model: string;
  displayModel: string;
  configured: boolean;
  apiKey?: string;
  awsRegion?: string;
}

function readProviderDetails(): ProviderDetails {
  const provider = providerSchema.parse(
    process.env.LLM_PROVIDER || "anthropic",
  );

  if (provider === "anthropic") {
    const model = (process.env.ANTHROPIC_MODEL || "claude-sonnet-5").trim();
    const validModel = /^claude-[a-z0-9._-]+$/u.test(model);
    return {
      name: provider,
      model,
      displayModel: validModel ? model : "Invalid Anthropic model ID",
      configured: Boolean(process.env.ANTHROPIC_API_KEY && validModel),
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  if (provider === "openai") {
    const model = (process.env.OPENAI_MODEL || "gpt-5.6-terra").trim();
    return {
      name: provider,
      model,
      displayModel: model || "OpenAI model not configured",
      configured: Boolean(process.env.OPENAI_API_KEY && model.trim()),
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  const model = (process.env.BEDROCK_MODEL_ID || "").trim();
  const awsRegion = process.env.AWS_REGION?.trim();
  return {
    name: provider,
    model,
    displayModel: model
      ? model.split("/").at(-1) || model
      : "Bedrock model not configured",
    configured: Boolean(awsRegion && model),
    awsRegion,
  };
}

export function getProviderSelection(): {
  name: ProviderName;
  model: string;
  configured: boolean;
} {
  const details = readProviderDetails();
  return {
    name: details.name,
    model: details.displayModel,
    configured: details.configured,
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const details = readProviderDetails();
  const timeoutMs = positiveInteger(25_000).parse(process.env.LLM_TIMEOUT_MS);
  const maxAttempts = positiveInteger(2).parse(process.env.LLM_MAX_ATTEMPTS);

  const common = {
    provider: details.name,
    model: details.model,
    displayModel: details.displayModel,
    configured: details.configured,
    timeoutMs,
    maxAttempts: Math.min(maxAttempts, 3),
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
