import type { InboundMessage, TriageResult } from "@/lib/domain/schemas";

export const OUTPUT_POLICY_VIOLATION_KEYS = [
  "sender_supplied_destination",
  "credential_disclosure",
  "financial_transaction",
  "sensitive_disclosure_without_verification",
] as const;

export type OutputPolicyViolation =
  (typeof OUTPUT_POLICY_VIOLATION_KEYS)[number];

export interface OutputPolicyAssessment {
  safe: boolean;
  violations: OutputPolicyViolation[];
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const DESTINATION_ACTION =
  /\b(?:click|follow|open|visit|browse|send|email|forward|upload|reply|respond)\b/iu;
const INDIRECT_DESTINATION_REFERENCE =
  /(?:\b(?:sender(?:'s)?|sender-provided|message|email|new|supplied|provided)\b.{0,48}\b(?:link|url|email(?: address)?|address|destination|contact)\b|\b(?:link|url|email(?: address)?|address|destination|contact)\b.{0,48}\b(?:sender|message|email|supplied|provided)\b)/iu;
const CREDENTIAL_DISCLOSURE =
  /\b(?:send|share|email|forward|upload|provid(?:e|ing)|disclos(?:e|ing)|reveal|enter)\b.{0,100}\b(?:passwords?|passcodes?|credentials?|api[ -]?keys?|secrets?|private[ -]?keys?|seed phrases?|recovery codes?|one[ -]?time codes?|otp)\b/giu;
const FINANCIAL_TRANSACTION =
  /\b(?:wire|transfer|withdraw|move funds?|send funds?|execute (?:a )?trade|buy (?:shares?|securities|stock)|sell (?:shares?|securities|stock|holdings?)|liquidate)\b/giu;
const SENSITIVE_DISCLOSURE =
  /\b(?:send|share|email|forward|upload|provid(?:e|ing)|disclos(?:e|ing)|releas(?:e|ing))\b.{0,120}\b(?:(?:account|portfolio|bank|financial|client|customer|tax|identity|personal|confidential)\s+(?:access|data|details|documents?|files?|information|records?|statements?)|statements?|tax returns?|social security(?: numbers?)?|ssns?|passports?)\b/giu;
const CLIENT_DOCUMENT_DISCLOSURE =
  /\b(?:send|share|email|forward|upload|provid(?:e|ing)|disclos(?:e|ing)|releas(?:e|ing))\b.{0,120}\b(?:documents?|records?)\b/giu;
const IDENTITY_VERIFICATION =
  /\b(?:verify|confirm|authenticate)\b.{0,80}\b(?:identity|sender)\b/iu;
const TRUSTED_VERIFICATION_CHANNEL =
  /(?:\b(?:approved|trusted|on-file|known)\b.{0,48}\b(?:channel|contact|destination)\b|\b(?:channel|contact|destination)\b.{0,48}\b(?:approved|trusted|on-file|known)\b)/iu;
const NEGATION_SUFFIX =
  /\b(?:do not|don't|never|must not|should not|avoid|without)\s*$/iu;

export class OutputPolicyError extends Error {
  readonly code = "unsafe_suggested_action" as const;
  readonly safeMessage =
    "The AI provider returned a suggested action that did not pass safety checks.";
  readonly violations: readonly OutputPolicyViolation[];

  constructor(violations: readonly OutputPolicyViolation[]) {
    super("Generated suggested action violated the output safety policy");
    this.name = "OutputPolicyError";
    this.violations = [...violations];
  }
}

function extractMatches(value: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...value.matchAll(pattern)].map((match) => match[0]);
}

function containsActionableDestination(
  action: string,
  message: InboundMessage,
): boolean {
  const actionDestinations = [
    ...extractMatches(action, URL_PATTERN),
    ...extractMatches(action, EMAIL_PATTERN),
  ];
  if (actionDestinations.length > 0) return true;
  if (!DESTINATION_ACTION.test(action)) return false;

  const source = [message.subject, message.body].join(" ");
  const sourceHasDestination =
    extractMatches(source, URL_PATTERN).length > 0 ||
    extractMatches(source, EMAIL_PATTERN).length > 0;
  return sourceHasDestination && INDIRECT_DESTINATION_REFERENCE.test(action);
}

function hasUnnegatedMatch(value: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prefix = value.slice(Math.max(0, index - 24), index);
    if (!NEGATION_SUFFIX.test(prefix)) return true;
  }
  return false;
}

function hasSensitiveDisclosureSafeguard(action: string): boolean {
  return (
    IDENTITY_VERIFICATION.test(action) &&
    TRUSTED_VERIFICATION_CHANNEL.test(action)
  );
}

export function assessTriageOutputPolicy(
  result: TriageResult,
  message: InboundMessage,
): OutputPolicyAssessment {
  const action = result.suggestedNextAction.normalize("NFKC");
  const violations: OutputPolicyViolation[] = [];

  if (containsActionableDestination(action, message)) {
    violations.push("sender_supplied_destination");
  }
  if (hasUnnegatedMatch(action, CREDENTIAL_DISCLOSURE)) {
    violations.push("credential_disclosure");
  }
  if (hasUnnegatedMatch(action, FINANCIAL_TRANSACTION)) {
    violations.push("financial_transaction");
  }
  const containsSensitiveDisclosure =
    hasUnnegatedMatch(action, SENSITIVE_DISCLOSURE) ||
    (result.category === "existing_client" &&
      hasUnnegatedMatch(action, CLIENT_DOCUMENT_DISCLOSURE));
  if (containsSensitiveDisclosure && !hasSensitiveDisclosureSafeguard(action)) {
    violations.push("sensitive_disclosure_without_verification");
  }

  return { safe: violations.length === 0, violations };
}

export function assertSafeTriageOutput(
  result: TriageResult,
  message: InboundMessage,
): TriageResult {
  const assessment = assessTriageOutputPolicy(result, message);
  if (!assessment.safe) {
    throw new OutputPolicyError(assessment.violations);
  }
  return result;
}
