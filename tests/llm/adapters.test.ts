import {
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicTriageProvider,
  type AnthropicClientLike,
} from "@/lib/llm/anthropic";
import {
  BedrockTriageProvider,
  type BedrockClientLike,
} from "@/lib/llm/bedrock";
import { ProviderError } from "@/lib/llm/errors";
import { OpenAITriageProvider, type OpenAIClientLike } from "@/lib/llm/openai";
import type { TriageProviderRequest } from "@/lib/llm/types";

const structuredResult = {
  summary: "A current client needs a statement by Friday.",
  category: "existing_client",
  priority: "high",
  suggestedNextAction: "Assign an advisor to send the statement today.",
};

const request: TriageProviderRequest = {
  systemPrompt: "Classify the message.",
  userPrompt: "<inbound_message>Example</inbound_message>",
  schemaName: "inbound_triage",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 240,
        pattern: "^[^\\r\\n]+$",
        description: "A concise summary.",
      },
    },
    required: ["summary"],
  },
  signal: new AbortController().signal,
};

describe("AnthropicTriageProvider", () => {
  it("uses Messages structured output and returns parsed unknown data with metadata", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(structuredResult) }],
      usage: { input_tokens: 123, output_tokens: 45 },
    });
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const provider = new AnthropicTriageProvider(
      { apiKey: "test-key", model: "claude-sonnet-5", timeoutMs: 2_000 },
      client,
    );

    await expect(provider.analyze(request)).resolves.toEqual({
      output: structuredResult,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { inputTokens: 123, outputTokens: 45 },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5",
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: expect.any(Object) },
        },
      }),
      expect.objectContaining({
        maxRetries: 0,
        timeout: 2_000,
        signal: request.signal,
      }),
    );
    const sentSchema = create.mock.calls[0]?.[0].output_config.format
      .schema as {
      properties: { summary: Record<string, unknown> };
    };
    expect(sentSchema.properties.summary).not.toHaveProperty("minLength");
    expect(sentSchema.properties.summary).not.toHaveProperty("maxLength");
    expect(sentSchema.properties.summary).not.toHaveProperty("pattern");
    expect(sentSchema.properties.summary.description).toContain("minLength");
    expect(JSON.stringify(request.schema)).toContain('"minLength":1');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
  });

  it("reports a refusal without exposing provider text", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "claude-sonnet-5",
      stop_reason: "refusal",
      content: [{ type: "text", text: "sensitive provider explanation" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const provider = new AnthropicTriageProvider(
      { apiKey: "test-key", timeoutMs: 2_000 },
      client,
    );

    const error = await provider
      .analyze(request)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "refusal", retryable: false });
    expect((error as Error).message).not.toContain("sensitive");
  });
});

describe("OpenAITriageProvider", () => {
  it("uses Responses strict JSON schema without storing the response", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "gpt-5.6-terra",
      status: "completed",
      error: null,
      incomplete_details: null,
      output_text: JSON.stringify(structuredResult),
      output: [],
      usage: { input_tokens: 91, output_tokens: 22 },
    });
    const client = { responses: { create } } as unknown as OpenAIClientLike;
    const provider = new OpenAITriageProvider(
      { apiKey: "test-key", model: "gpt-5.6-terra", timeoutMs: 2_500 },
      client,
    );

    await expect(provider.analyze(request)).resolves.toEqual({
      output: structuredResult,
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 91, outputTokens: 22 },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        instructions: request.systemPrompt,
        input: request.userPrompt,
        store: false,
        reasoning: { effort: "none" },
        text: {
          format: {
            type: "json_schema",
            name: "inbound_triage",
            description: expect.any(String),
            schema: request.schema,
            strict: true,
          },
        },
      }),
      expect.objectContaining({
        maxRetries: 0,
        timeout: 2_500,
        signal: request.signal,
      }),
    );
  });

  it("rejects incomplete structured output", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "gpt-5.6-terra",
      status: "incomplete",
      error: null,
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "{",
      output: [],
      usage: undefined,
    });
    const client = { responses: { create } } as unknown as OpenAIClientLike;
    const provider = new OpenAITriageProvider(
      { apiKey: "test-key", timeoutMs: 2_000 },
      client,
    );

    await expect(provider.analyze(request)).rejects.toMatchObject({
      code: "invalid_output",
      retryable: false,
    });
  });

  it("omits reasoning parameters for models without a verified none effort", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "gpt-4o-mini",
      status: "completed",
      error: null,
      incomplete_details: null,
      output_text: JSON.stringify(structuredResult),
      output: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { responses: { create } } as unknown as OpenAIClientLike;
    const provider = new OpenAITriageProvider(
      { apiKey: "test-key", model: "gpt-4o-mini", timeoutMs: 2_000 },
      client,
    );

    await provider.analyze(request);

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("reasoning");
  });

  it("maps response-level quota errors without exposing provider details", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "gpt-5.6-terra",
      status: "failed",
      error: {
        code: "insufficient_quota",
        message: "raw billing account detail",
      },
      incomplete_details: null,
      output_text: "",
      output: [],
      usage: undefined,
    });
    const client = { responses: { create } } as unknown as OpenAIClientLike;
    const provider = new OpenAITriageProvider(
      { apiKey: "test-key", timeoutMs: 2_000 },
      client,
    );

    const error = await provider
      .analyze(request)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "quota_exceeded", retryable: false });
    expect((error as Error).message).not.toContain("billing account detail");
  });
});

describe("BedrockTriageProvider", () => {
  it("uses Converse textFormat and JSON-stringifies its schema", async () => {
    const response = {
      stopReason: "end_turn",
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify(structuredResult) }],
        },
      },
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      metrics: { latencyMs: 100 },
      $metadata: {},
    } as ConverseCommandOutput;
    const send = vi.fn().mockResolvedValue(response);
    const client = { send } as unknown as BedrockClientLike;
    const provider = new BedrockTriageProvider(
      {
        region: "us-east-1",
        model: "anthropic.claude-sonnet-4-6-20260801-v1:0",
        timeoutMs: 120_000,
      },
      client,
    );

    await expect(provider.analyze(request)).resolves.toEqual({
      output: structuredResult,
      provider: "bedrock",
      model: "anthropic.claude-sonnet-4-6-20260801-v1:0",
      usage: { inputTokens: 80, outputTokens: 20 },
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConverseCommand);
    expect((command as ConverseCommand).input).toMatchObject({
      modelId: "anthropic.claude-sonnet-4-6-20260801-v1:0",
      system: [{ text: request.systemPrompt }],
      messages: [{ role: "user", content: [{ text: request.userPrompt }] }],
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: {
              name: "inbound_triage",
              schema: expect.any(String),
            },
          },
        },
      },
    });
    const schemaText = (command as ConverseCommand).input.outputConfig
      ?.textFormat?.structure?.jsonSchema?.schema;
    expect(schemaText).toBeTypeOf("string");
    const sentSchema = JSON.parse(schemaText ?? "{}") as {
      properties: { summary: Record<string, unknown> };
    };
    expect(sentSchema.properties.summary).not.toHaveProperty("minLength");
    expect(sentSchema.properties.summary).not.toHaveProperty("maxLength");
    expect(sentSchema.properties.summary).not.toHaveProperty("pattern");
    expect(sentSchema.properties.summary.description).toContain(
      "Application-enforced constraints",
    );
    expect(sentSchema.properties.summary.description).toContain("minLength");
    expect(JSON.stringify(request.schema)).toContain('"minLength":1');
    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: request.signal });
  });

  it("treats a guardrail intervention as a refusal", async () => {
    const send = vi.fn().mockResolvedValue({
      stopReason: "guardrail_intervened",
      output: undefined,
      usage: undefined,
    });
    const client = { send } as unknown as BedrockClientLike;
    const provider = new BedrockTriageProvider(
      {
        region: "us-east-1",
        model: "anthropic.claude-sonnet-4-6-v1:0",
        timeoutMs: 120_000,
      },
      client,
    );

    await expect(provider.analyze(request)).rejects.toMatchObject({
      code: "refusal",
      retryable: false,
    });
  });
});
