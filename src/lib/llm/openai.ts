import "server-only";

import OpenAI from "openai";
import { providerError, toProviderError } from "./errors";
import { parseStructuredOutput } from "./structured-output";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TRIAGE_SCHEMA_NAME,
  type TriageProvider,
  type TriageProviderRequest,
  type TriageProviderResult,
} from "./types";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";

export type OpenAIClientLike = Pick<OpenAI, "responses">;

export interface OpenAITriageProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs: number;
}

export class OpenAITriageProvider implements TriageProvider {
  readonly name = "openai" as const;
  readonly model: string;

  private readonly client: OpenAIClientLike;
  private readonly timeoutMs: number;

  constructor(options: OpenAITriageProviderOptions, client?: OpenAIClientLike) {
    if (options.apiKey.trim().length === 0) {
      throw providerError("configuration", this.name);
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw providerError("configuration", this.name);
    }

    this.model = options.model?.trim() || DEFAULT_OPENAI_MODEL;
    this.timeoutMs = options.timeoutMs;
    this.client =
      client ??
      new OpenAI({
        apiKey: options.apiKey,
        maxRetries: 0,
        timeout: options.timeoutMs,
      });
  }

  async analyze(request: TriageProviderRequest): Promise<TriageProviderResult> {
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          instructions: request.systemPrompt,
          input: request.userPrompt,
          max_output_tokens:
            request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          reasoning: { effort: "none" },
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName ?? DEFAULT_TRIAGE_SCHEMA_NAME,
              description: "A validated classification of one inbound message.",
              schema: request.schema,
              strict: true,
            },
          },
        },
        {
          signal: request.signal,
          maxRetries: 0,
          timeout: this.timeoutMs,
        },
      );

      const refused = response.output.some(
        (item) =>
          item.type === "message" &&
          item.content.some((part) => part.type === "refusal"),
      );
      if (refused || response.incomplete_details?.reason === "content_filter") {
        throw providerError("refusal", this.name);
      }
      if (
        response.error ||
        (response.status !== undefined && response.status !== "completed")
      ) {
        if (response.status === "incomplete") {
          throw providerError("invalid_output", this.name);
        }
        throw providerError("provider_unavailable", this.name, {
          retryable: true,
        });
      }

      return {
        output: parseStructuredOutput(response.output_text, this.name),
        provider: this.name,
        model: response.model || this.model,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
        },
      };
    } catch (error) {
      throw toProviderError(error, this.name);
    }
  }
}
