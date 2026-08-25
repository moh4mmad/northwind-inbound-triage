import "server-only";

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { providerError, toProviderError } from "./errors";
import { MAX_PROVIDER_ATTEMPT_TIMEOUT_MS } from "./limits";
import {
  sanitizeModelForDisplay,
  supportsBedrockStructuredTriage,
} from "./model-capabilities";
import {
  parseStructuredOutput,
  transformBedrockStructuredOutputSchema,
} from "./structured-output";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TRIAGE_SCHEMA_NAME,
  type TriageProvider,
  type TriageProviderRequest,
  type TriageProviderResult,
} from "./types";

export type BedrockClientLike = Pick<BedrockRuntimeClient, "send">;

export interface BedrockTriageProviderOptions {
  region: string;
  model: string;
  timeoutMs: number;
}

export class BedrockTriageProvider implements TriageProvider {
  readonly name = "bedrock" as const;
  readonly model: string;

  private readonly client: BedrockClientLike;

  constructor(
    options: BedrockTriageProviderOptions,
    client?: BedrockClientLike,
  ) {
    if (
      options.region.trim().length === 0 ||
      options.model.trim().length === 0 ||
      !supportsBedrockStructuredTriage(options.model) ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_PROVIDER_ATTEMPT_TIMEOUT_MS
    ) {
      throw providerError("configuration", this.name);
    }

    this.model = options.model.trim();
    this.client =
      client ??
      new BedrockRuntimeClient({
        region: options.region.trim(),
        maxAttempts: 1,
        requestHandler: {
          connectionTimeout: Math.min(5_000, options.timeoutMs),
          requestTimeout: options.timeoutMs,
        },
      });
  }

  async analyze(request: TriageProviderRequest): Promise<TriageProviderResult> {
    try {
      const outputSchema = transformBedrockStructuredOutputSchema(
        request.schema,
      );
      const command = new ConverseCommand({
        modelId: this.model,
        system: [{ text: request.systemPrompt }],
        messages: [
          {
            role: "user",
            content: [{ text: request.userPrompt }],
          },
        ],
        inferenceConfig: {
          maxTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
        outputConfig: {
          textFormat: {
            type: "json_schema",
            structure: {
              jsonSchema: {
                name: request.schemaName ?? DEFAULT_TRIAGE_SCHEMA_NAME,
                description:
                  "A validated classification of one inbound message.",
                schema: JSON.stringify(outputSchema),
              },
            },
          },
        },
      });

      const response = (await this.client.send(command, {
        abortSignal: request.signal,
      })) as ConverseCommandOutput;

      if (
        response.stopReason === "content_filtered" ||
        response.stopReason === "guardrail_intervened"
      ) {
        throw providerError("refusal", this.name);
      }
      if (response.stopReason !== "end_turn") {
        throw providerError("invalid_output", this.name);
      }

      const text =
        response.output?.message?.content
          ?.flatMap((block) =>
            "text" in block && typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("") ?? "";

      return {
        output: parseStructuredOutput(text, this.name),
        provider: this.name,
        model: sanitizeModelForDisplay(this.name, this.model),
        usage: {
          inputTokens: response.usage?.inputTokens ?? null,
          outputTokens: response.usage?.outputTokens ?? null,
        },
      };
    } catch (error) {
      throw toProviderError(error, this.name);
    }
  }
}
