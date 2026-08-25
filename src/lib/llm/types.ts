import type { ProviderName } from "@/lib/domain/taxonomy";

export interface ProviderTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TriageProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TriageProviderResult {
  output: unknown;
  provider: ProviderName;
  model: string;
  usage: ProviderTokenUsage;
}

export interface TriageProvider {
  readonly name: ProviderName;
  readonly model: string;

  analyze(request: TriageProviderRequest): Promise<TriageProviderResult>;
}

export const DEFAULT_TRIAGE_SCHEMA_NAME = "inbound_triage";
export const DEFAULT_MAX_OUTPUT_TOKENS = 800;
