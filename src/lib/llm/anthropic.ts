import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { providerError, toProviderError } from "./errors";
import { MAX_PROVIDER_ATTEMPT_TIMEOUT_MS } from "./limits";
import { supportsAnthropicStructuredTriage } from "./model-capabilities";
import { parseStructuredOutput } from "./structured-output";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type TriageProvider,
  type TriageProviderRequest,
  type TriageProviderResult,
} from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

export type AnthropicClientLike = Pick<Anthropic, "messages">;

export interface AnthropicTriageProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs: number;
}

export class AnthropicTriageProvider implements TriageProvider {
  readonly name = "anthropic" as const;
  readonly model: string;

  private readonly client: AnthropicClientLike;
  private readonly timeoutMs: number;

  constructor(
    options: AnthropicTriageProviderOptions,
    client?: AnthropicClientLike,
  ) {
    if (options.apiKey.trim().length === 0) {
      throw providerError("configuration", this.name);
    }
    if (
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_PROVIDER_ATTEMPT_TIMEOUT_MS
    ) {
      throw providerError("configuration", this.name);
    }

    this.model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    if (!supportsAnthropicStructuredTriage(this.model)) {
      throw providerError("configuration", this.name);
    }
    this.timeoutMs = options.timeoutMs;
    this.client =
      client ??
      new Anthropic({
        apiKey: options.apiKey.trim(),
        maxRetries: 0,
        timeout: options.timeoutMs,
      });
  }

  async analyze(request: TriageProviderRequest): Promise<TriageProviderResult> {
    try {
      const outputFormat = jsonSchemaOutputFormat(
        request.schema as Parameters<typeof jsonSchemaOutputFormat>[0],
      );
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          system: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt }],
          output_config: {
            effort: "low",
            format: {
              type: outputFormat.type,
              schema: outputFormat.schema,
            },
          },
        },
        {
          signal: request.signal,
          maxRetries: 0,
          timeout: this.timeoutMs,
        },
      );

      if (response.stop_reason === "refusal") {
        throw providerError("refusal", this.name);
      }
      if (response.stop_reason !== "end_turn") {
        throw providerError("invalid_output", this.name);
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        output: parseStructuredOutput(text, this.name),
        provider: this.name,
        model: response.model || this.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      throw toProviderError(error, this.name);
    }
  }
}
