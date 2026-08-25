import { z } from "zod";
import {
  inboundMessageSchema,
  triageRunSchema,
  type MessageView,
} from "./schemas";
import { PROVIDER_KEYS } from "./taxonomy";

/**
 * Browser-safe projection of a triage run. Provider request metadata and token
 * accounting stay on the server because the dashboard does not use them.
 */
export const dashboardTriageRunSchema = triageRunSchema.pick({
  status: true,
  inputQuality: true,
  reviewReasons: true,
  summary: true,
  category: true,
  priority: true,
  suggestedNextAction: true,
  errorCode: true,
  errorMessage: true,
});

export const dashboardMessageSchema = inboundMessageSchema.extend({
  latestRun: dashboardTriageRunSchema.nullable(),
});

export const dashboardListResponseSchema = z
  .object({
    messages: z.array(dashboardMessageSchema),
    provider: z
      .object({
        name: z.enum(PROVIDER_KEYS),
        model: z.string().trim().min(1).max(300),
        configured: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type DashboardTriageRun = z.infer<typeof dashboardTriageRunSchema>;
export type DashboardMessage = z.infer<typeof dashboardMessageSchema>;
export type DashboardListResponse = z.infer<typeof dashboardListResponseSchema>;

const RETRYABLE_PERSISTED_ERROR_CODES = new Set([
  "RATE_LIMIT",
  "TIMEOUT",
  "NETWORK",
  "PROVIDER_UNAVAILABLE",
  "PROCESS_INTERRUPTED",
  "CANCELLED",
]);

export function isPersistedRunRetryable(
  errorCode: string | null | undefined,
): boolean {
  return RETRYABLE_PERSISTED_ERROR_CODES.has(
    (errorCode ?? "").trim().toUpperCase(),
  );
}

export function toDashboardMessage(message: MessageView): DashboardMessage {
  const { latestRun } = message;

  return dashboardMessageSchema.parse({
    id: message.id,
    received_at: message.received_at,
    channel: message.channel,
    from_name: message.from_name,
    from_org: message.from_org,
    subject: message.subject,
    body: message.body,
    latestRun:
      latestRun === null
        ? null
        : {
            status: latestRun.status,
            inputQuality: latestRun.inputQuality,
            reviewReasons: latestRun.reviewReasons,
            summary: latestRun.summary,
            category: latestRun.category,
            priority: latestRun.priority,
            suggestedNextAction: latestRun.suggestedNextAction,
            errorCode: latestRun.errorCode,
            errorMessage: latestRun.errorMessage,
          },
  });
}
