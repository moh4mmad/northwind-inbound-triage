import { z } from "zod";
import {
  CATEGORY_KEYS,
  INPUT_QUALITY_KEYS,
  PRIORITY_KEYS,
  PROVIDER_KEYS,
  RUN_STATUS_KEYS,
} from "./taxonomy";

export const inboundMessageSchema = z
  .object({
    id: z.string().regex(/^inb-\d{3}$/),
    received_at: z.string().datetime({ offset: true }),
    channel: z.string().min(1).max(80),
    from_name: z.string().max(300),
    from_org: z.string().max(300),
    subject: z.string().max(1_000),
    body: z.string().max(100_000),
  })
  .strict();

export const inboundMessagesSchema = z
  .array(inboundMessageSchema)
  .min(1)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate message id: ${item.id}`,
          path: [index, "id"],
        });
      }
      seen.add(item.id);
    });
  });

const UNSAFE_GENERATED_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function generatedLine(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/[\r\n]/u.test(value), "Must be a single line")
    .refine(
      (value) => !UNSAFE_GENERATED_UNICODE.test(value),
      "Must not contain control or Unicode formatting characters",
    );
}

export const triageResultSchema = z
  .object({
    summary: generatedLine(240),
    category: z.enum(CATEGORY_KEYS),
    priority: z.enum(PRIORITY_KEYS),
    suggestedNextAction: generatedLine(400),
  })
  .strict();

export const qualityReasonSchema = z.enum([
  "near_empty",
  "garbled_or_truncated",
  "missing_sender",
  "missing_subject",
  "unknown_organization",
  "low_context",
  "prompt_truncated",
  "suspicious_unicode",
  "suspicious_instructions",
]);

export const triageRunSchema = z
  .object({
    id: z.number().int().positive(),
    messageId: z.string().regex(/^inb-\d{3}$/),
    status: z.enum(RUN_STATUS_KEYS),
    inputQuality: z.enum(INPUT_QUALITY_KEYS),
    reviewReasons: z.array(qualityReasonSchema),
    summary: generatedLine(240).nullable(),
    category: z.enum(CATEGORY_KEYS).nullable(),
    priority: z.enum(PRIORITY_KEYS).nullable(),
    suggestedNextAction: generatedLine(400).nullable(),
    provider: z.enum(PROVIDER_KEYS),
    model: generatedLine(300),
    resolvedModel: generatedLine(300).nullable(),
    promptVersion: generatedLine(100),
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    errorMessage: generatedLine(500).nullable(),
    attemptCount: z.number().int().positive(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const messageViewSchema = inboundMessageSchema.extend({
  latestRun: triageRunSchema.nullable(),
});

export const messageListResponseSchema = z.object({
  messages: z.array(messageViewSchema),
  provider: z.object({
    name: z.enum(PROVIDER_KEYS),
    model: z.string(),
    configured: z.boolean(),
    configurationStatus: z.enum(["locally_configured", "not_configured"]),
  }),
});

export type InboundMessage = z.infer<typeof inboundMessageSchema>;
export type TriageResult = z.infer<typeof triageResultSchema>;
export type QualityReason = z.infer<typeof qualityReasonSchema>;
export type TriageRun = z.infer<typeof triageRunSchema>;
export type MessageView = z.infer<typeof messageViewSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

export const triageWireJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      pattern: "^[^\\r\\n]+$",
      description: "A concise, factual one-line summary.",
    },
    category: { type: "string", enum: [...CATEGORY_KEYS] },
    priority: { type: "string", enum: [...PRIORITY_KEYS] },
    suggestedNextAction: {
      type: "string",
      minLength: 1,
      maxLength: 400,
      pattern: "^[^\\r\\n]+$",
      description: "A concrete, advisory next step for a human reviewer.",
    },
  },
  required: ["summary", "category", "priority", "suggestedNextAction"],
} as const;
