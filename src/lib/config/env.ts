import "server-only";

import { z } from "zod";
import { PROVIDER_KEYS, type ProviderName } from "@/lib/domain/taxonomy";

const providerSchema = z.enum(PROVIDER_KEYS);
const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().optional().transform((value) => value ?? fallback);

export interface RuntimeConfig {
  provider: ProviderName;
  model: string;
  configured: boolean;
  apiKey?: string;
  awsRegion?: string;
  timeoutMs: number;
  maxAttempts: number;
  maxConcurrency: number;
  databasePath: string;
}

export function getProviderSelection(): { name: ProviderName; model: string; configured: boolean } {
  const provider = providerSchema.parse(process.env.LLM_PROVIDER || "anthropic");

  if (provider === "anthropic") {
    return {
      name: provider,
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
    };
  }

  if (provider === "openai") {
    return {
      name: provider,
      model: process.env.OPENAI_MODEL || "gpt-5.6-terra",
      configured: Boolean(process.env.OPENAI_API_KEY),
    };
  }

  return {
    name: provider,
    model: process.env.BEDROCK_MODEL_ID || "Bedrock model not configured",
    configured: Boolean(process.env.AWS_REGION && process.env.BEDROCK_MODEL_ID),
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const selection = getProviderSelection();
  const timeoutMs = positiveInteger(25_000).parse(process.env.LLM_TIMEOUT_MS);
  const maxAttempts = positiveInteger(2).parse(process.env.LLM_MAX_ATTEMPTS);
  const maxConcurrency = positiveInteger(3).parse(process.env.LLM_MAX_CONCURRENCY);

  const common = {
    provider: selection.name,
    model: selection.model,
    configured: selection.configured,
    timeoutMs,
    maxAttempts: Math.min(maxAttempts, 3),
    maxConcurrency: Math.min(maxConcurrency, 5),
    databasePath: process.env.DATABASE_PATH || "./data/triage.sqlite",
  };

  if (selection.name === "anthropic") {
    return { ...common, apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (selection.name === "openai") {
    return { ...common, apiKey: process.env.OPENAI_API_KEY };
  }
  return { ...common, awsRegion: process.env.AWS_REGION };
}
