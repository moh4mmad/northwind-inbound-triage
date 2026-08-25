import type { InboundMessage, QualityReason } from "./schemas";
import type { InputQuality } from "./taxonomy";

export const MAX_PROMPT_BODY_CHARS = 8_000;
export const PROMPT_OMISSION_MARKER =
  "\n[... content omitted by application ...]\n";
const SENTINEL_ORGANIZATIONS = new Set(["", "(individual)", "(unknown)"]);
const DANGEROUS_UNICODE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Cs}]/u;
const DANGEROUS_UNICODE_GLOBAL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Cs}]/gu;
const GARBLED_MARKERS =
  /(?:\uFFFD{2,}|content-type:\s*multipart|forwarded message truncated|=\?utf-8\?[bq]\?)/iu;
const SUSPICIOUS_INSTRUCTIONS =
  /(?:<\/?inbound_message\b|\b(?:ignore|disregard|override)\b.{0,48}\b(?:previous|prior|system|developer)\b.{0,24}\b(?:instructions?|rules?)\b|\b(?:set|return|output|classify)\b.{0,48}\b(?:category|priority)\b.{0,24}\b(?:to|as)\b)/iu;

export interface QualityAssessment {
  quality: InputQuality;
  reasons: QualityReason[];
  promptMessage: InboundMessage;
  requiresReview: boolean;
}

function semanticLength(value: string): number {
  return value.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

function normalizePromptText(value: string): string {
  return value.normalize("NFKC").replace(DANGEROUS_UNICODE_GLOBAL, "").trim();
}

function truncatePromptBody(value: string): {
  body: string;
  truncated: boolean;
} {
  if (value.length <= MAX_PROMPT_BODY_CHARS) {
    return { body: value, truncated: false };
  }

  const retainedCharacters =
    MAX_PROMPT_BODY_CHARS - PROMPT_OMISSION_MARKER.length;
  const headLength = Math.ceil(retainedCharacters / 2);
  const tailLength = Math.floor(retainedCharacters / 2);
  let headEnd = headLength;
  let tailStart = value.length - tailLength;

  // Avoid cutting a valid surrogate pair at either projection boundary.
  if (
    headEnd > 0 &&
    /[\uD800-\uDBFF]/u.test(value.charAt(headEnd - 1)) &&
    /[\uDC00-\uDFFF]/u.test(value.charAt(headEnd))
  ) {
    headEnd -= 1;
  }
  if (
    tailStart > 0 &&
    /[\uDC00-\uDFFF]/u.test(value.charAt(tailStart)) &&
    /[\uD800-\uDBFF]/u.test(value.charAt(tailStart - 1))
  ) {
    tailStart += 1;
  }

  return {
    body: `${value.slice(0, headEnd)}${PROMPT_OMISSION_MARKER}${value.slice(tailStart)}`,
    truncated: true,
  };
}

export function normalizeOrganization(value: string): string | null {
  const projected = normalizePromptText(value);
  const normalized = projected.toLowerCase();
  return SENTINEL_ORGANIZATIONS.has(normalized) ? null : projected;
}

export function assessInputQuality(message: InboundMessage): QualityAssessment {
  const reasons: QualityReason[] = [];
  const rawPromptFields = [
    message.channel,
    message.from_name,
    message.from_org,
    message.subject,
    message.body,
  ].join(" ");
  const hasSuspiciousUnicode = DANGEROUS_UNICODE.test(rawPromptFields);
  const fromName = normalizePromptText(message.from_name);
  const fromOrg = normalizeOrganization(message.from_org) ?? "";
  const subject = normalizePromptText(message.subject);
  const normalizedBody = normalizePromptText(message.body);
  const combined = `${subject} ${normalizedBody}`.trim();
  const allProjectedFields = [
    normalizePromptText(message.channel),
    fromName,
    fromOrg,
    subject,
    normalizedBody,
  ].join(" ");

  if (semanticLength(combined) < 3) reasons.push("near_empty");
  if (GARBLED_MARKERS.test(`${fromName} ${combined}`)) {
    reasons.push("garbled_or_truncated");
  }
  if (SUSPICIOUS_INSTRUCTIONS.test(allProjectedFields)) {
    reasons.push("suspicious_instructions");
  }
  if (hasSuspiciousUnicode) reasons.push("suspicious_unicode");
  if (!fromName) reasons.push("missing_sender");
  if (!subject) reasons.push("missing_subject");
  if (normalizeOrganization(message.from_org) === null)
    reasons.push("unknown_organization");

  const wordCount = combined.split(/\s+/u).filter(Boolean).length;
  if (
    wordCount < 8 ||
    (/\bfollowing up\b/iu.test(combined) &&
      !/\b(client|planning|portfolio|referral|vendor|recruit)/iu.test(combined))
  ) {
    reasons.push("low_context");
  }

  const projectedBody = truncatePromptBody(normalizedBody);
  if (projectedBody.truncated) {
    reasons.push("prompt_truncated");
  }

  const malformed =
    reasons.includes("near_empty") || reasons.includes("garbled_or_truncated");
  const lowSignal =
    reasons.includes("low_context") ||
    reasons.includes("prompt_truncated") ||
    reasons.includes("suspicious_unicode") ||
    reasons.includes("suspicious_instructions");
  const quality: InputQuality = malformed
    ? "malformed"
    : lowSignal
      ? "low_signal"
      : "valid";

  return {
    quality,
    reasons,
    promptMessage: {
      ...message,
      channel: normalizePromptText(message.channel),
      from_name: fromName,
      from_org: fromOrg,
      subject,
      body: projectedBody.body,
    },
    requiresReview: quality !== "valid",
  };
}

export function requiresInputReview(
  assessment: Pick<QualityAssessment, "quality" | "reasons">,
): boolean {
  return (
    assessment.quality !== "valid" ||
    assessment.reasons.includes("prompt_truncated") ||
    assessment.reasons.includes("suspicious_unicode") ||
    assessment.reasons.includes("suspicious_instructions")
  );
}
