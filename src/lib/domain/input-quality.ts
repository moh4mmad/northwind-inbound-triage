import type { InboundMessage, QualityReason } from "./schemas";
import type { InputQuality } from "./taxonomy";

const MAX_PROMPT_BODY_CHARS = 8_000;
const SENTINEL_ORGANIZATIONS = new Set(["", "(individual)", "(unknown)"]);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const GARBLED_MARKERS =
  /(?:\uFFFD{2,}|content-type:\s*multipart|forwarded message truncated|=\?utf-8\?[bq]\?)/iu;

export interface QualityAssessment {
  quality: InputQuality;
  reasons: QualityReason[];
  promptMessage: InboundMessage;
}

function semanticLength(value: string): number {
  return value.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

export function normalizeOrganization(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return SENTINEL_ORGANIZATIONS.has(normalized) ? null : value.trim();
}

export function assessInputQuality(message: InboundMessage): QualityAssessment {
  const reasons: QualityReason[] = [];
  const combined = `${message.subject} ${message.body}`.trim();
  const hasControlCharacters = CONTROL_CHARACTERS.test(combined);
  CONTROL_CHARACTERS.lastIndex = 0;

  if (semanticLength(combined) < 3) reasons.push("near_empty");
  if (
    hasControlCharacters ||
    GARBLED_MARKERS.test(`${message.from_name} ${combined}`)
  ) {
    reasons.push("garbled_or_truncated");
  }
  if (!message.from_name.trim()) reasons.push("missing_sender");
  if (!message.subject.trim()) reasons.push("missing_subject");
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

  let body = message.body;
  if (body.length > MAX_PROMPT_BODY_CHARS) {
    body = `${body.slice(0, MAX_PROMPT_BODY_CHARS)}\n[truncated by application]`;
    reasons.push("prompt_truncated");
  }

  const malformed =
    reasons.includes("near_empty") || reasons.includes("garbled_or_truncated");
  const lowSignal = reasons.includes("low_context");

  return {
    quality: malformed ? "malformed" : lowSignal ? "low_signal" : "valid",
    reasons,
    promptMessage: {
      ...message,
      from_name: message.from_name.replace(CONTROL_CHARACTERS, "").trim(),
      from_org: normalizeOrganization(message.from_org) ?? "",
      subject: message.subject.replace(CONTROL_CHARACTERS, "").trim(),
      body: body.replace(CONTROL_CHARACTERS, "").trim(),
    },
  };
}
