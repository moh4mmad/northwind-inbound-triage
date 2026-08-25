import {
  isPersistedRunRetryable,
  type DashboardMessage,
} from "@/lib/domain/dashboard";
import type { QualityReason } from "@/lib/domain/schemas";
import { CATEGORY_DEFINITIONS } from "@/lib/domain/taxonomy";

export interface VisibleTriageError {
  code: string;
  message: string;
  retryable: boolean;
}

interface MessageCardProps {
  message: DashboardMessage;
  error?: VisibleTriageError;
  isActive: boolean;
  isQueued: boolean;
  isBatchRunning: boolean;
  isConfigured: boolean;
  isExpanded: boolean;
  onAnalyze: (messageId: string) => void;
  onToggleExpanded: (messageId: string) => void;
}

const QUALITY_REASON_LABELS: Record<QualityReason, string> = {
  near_empty: "The message has almost no usable content.",
  garbled_or_truncated: "The source appears garbled or truncated.",
  missing_sender: "The sender is missing.",
  missing_subject: "The subject is missing.",
  unknown_organization: "The organization is not known.",
  low_context: "The message does not contain enough routing context.",
  prompt_truncated:
    "The message was too long, so only its beginning and end were analyzed.",
  suspicious_unicode:
    "The message contains suspicious or unsupported Unicode characters.",
  suspicious_instructions:
    "The message contains instructions that may be trying to influence its own triage.",
};

const BODY_UNSAFE_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\p{Cf}\p{Cs}]/gu;
const INLINE_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
function titleCase(value: string): string {
  return sanitizeInlineDisplay(value)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeInlineDisplay(value: string): string {
  return value.replace(INLINE_UNSAFE_CHARACTERS, "�").trim();
}

function displaySender(value: string): string {
  return sanitizeInlineDisplay(value) || "Unknown sender";
}

function displayOrganization(value: string): string | null {
  const trimmed = sanitizeInlineDisplay(value);
  const normalized = trimmed.toLowerCase();

  if (!trimmed || normalized === "(unknown)") return null;
  if (normalized === "(individual)") return "Individual";
  return trimmed;
}

function displaySubject(value: string): string {
  return sanitizeInlineDisplay(value) || "No subject";
}

function displayBody(value: string): string {
  if (!value.trim()) return "No message body was provided.";
  return value.replace(BODY_UNSAFE_CHARACTERS, "�");
}

function displayBodyPreview(value: string): string {
  return displayBody(value).replace(/\s+/gu, " ").trim();
}

function formatReceivedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(date);
}

function getStatus(
  message: DashboardMessage,
  error: VisibleTriageError | undefined,
  isActive: boolean,
  isQueued: boolean,
) {
  if (isActive) return { label: "Analyzing", className: "status-processing" };
  if (isQueued) return { label: "Queued", className: "status-processing" };
  if (error) return { label: "Failed", className: "status-failed" };

  switch (message.latestRun?.status) {
    case "processing":
      return { label: "Processing", className: "status-processing" };
    case "succeeded":
      return { label: "Analyzed", className: "status-succeeded" };
    case "needs_review":
      return { label: "Needs review", className: "status-review" };
    case "failed":
      return { label: "Failed", className: "status-failed" };
    default:
      return { label: "Untriaged", className: "status-untriaged" };
  }
}

function getActionLabel(
  message: DashboardMessage,
  error: VisibleTriageError | undefined,
  isActive: boolean,
  isQueued: boolean,
) {
  if (isActive) return "Analyzing…";
  if (isQueued) return "Queued";
  if (message.latestRun?.status === "processing") return "Processing…";
  if (error || message.latestRun?.status === "failed") {
    const visibleError = error ?? runError(message);
    return visibleError?.retryable === false ? "Cannot retry" : "Retry";
  }
  if (message.latestRun) return "Analyze again";
  return "Analyze";
}

function runError(message: DashboardMessage): VisibleTriageError | undefined {
  const run = message.latestRun;
  if (run?.status !== "failed") return undefined;

  return {
    code: run.errorCode ?? "analysis_failed",
    message:
      run.errorMessage?.trim() ||
      "The provider could not analyze this message.",
    retryable: isPersistedRunRetryable(run.errorCode),
  };
}

function reviewCopy(message: DashboardMessage): string | null {
  const run = message.latestRun;
  if (run?.status !== "needs_review") return null;

  const actionableReasons = run.reviewReasons.filter(
    (reason) =>
      reason !== "unknown_organization" && reason !== "missing_subject",
  );

  if (actionableReasons.length === 0) {
    return "The model could not route this message confidently. A human should review the original context.";
  }

  return actionableReasons
    .map((reason) => QUALITY_REASON_LABELS[reason])
    .join(" ");
}

export function MessageCard({
  message,
  error,
  isActive,
  isQueued,
  isBatchRunning,
  isConfigured,
  isExpanded,
  onAnalyze,
  onToggleExpanded,
}: MessageCardProps) {
  const displayedMessage: DashboardMessage = error
    ? { ...message, latestRun: null }
    : message;
  const run = displayedMessage.latestRun;
  const visibleError = error ?? runError(displayedMessage);
  const status = getStatus(displayedMessage, error, isActive, isQueued);
  const subject = displaySubject(message.subject);
  const sender = displaySender(message.from_name);
  const organization = displayOrganization(message.from_org);
  const reviewMessage = reviewCopy(displayedMessage);
  const isPersistedProcessing = run?.status === "processing";
  const actionDisabled =
    !isConfigured ||
    isActive ||
    isQueued ||
    isBatchRunning ||
    isPersistedProcessing ||
    visibleError?.retryable === false;
  const originalBodyId = `${message.id}-original-body`;
  const avatarLetter =
    sender === "Unknown sender" ? "?" : sender.charAt(0).toUpperCase();
  const priorityClass = run?.priority ? `priority-${run.priority}` : "";
  const actionLabel = getActionLabel(
    displayedMessage,
    error,
    isActive,
    isQueued,
  );

  return (
    <article
      className={`message-card ${priorityClass}`}
      aria-labelledby={`${message.id}-subject`}
    >
      <div className="message-row-main">
        <div className="sender-cell">
          <span className="sender-avatar" aria-hidden="true">
            {avatarLetter}
          </span>
          <div className="sender-copy">
            <strong>{sender}</strong>
            <span>{organization ?? titleCase(message.channel)}</span>
          </div>
        </div>

        <div className="message-cell">
          <div className="subject-line">
            <h2 id={`${message.id}-subject`}>{subject}</h2>
            <span>{titleCase(message.channel)}</span>
          </div>

          {run?.summary ? (
            <p className="result-summary">
              <span className="result-label">AI summary</span>
              <span>{run.summary}</span>
            </p>
          ) : (
            <p className="source-preview">
              <span className="sr-only">Original message preview: </span>
              {displayBodyPreview(message.body)}
            </p>
          )}

          {run?.suggestedNextAction ? (
            <p className="next-action">
              <span>Next</span>
              <span>{run.suggestedNextAction}</span>
            </p>
          ) : null}

          {reviewMessage ? (
            <div className="review-notice">
              <strong>Review needed.</strong> {reviewMessage}
            </div>
          ) : null}

          {visibleError ? (
            <div className="inline-error" role="alert">
              <strong>Analysis failed.</strong>
              <span>{visibleError.message}</span>
            </div>
          ) : null}

          {isActive || isQueued || isPersistedProcessing ? (
            <p className="processing-copy">
              Analysis in progress; this row will update when it finishes.
            </p>
          ) : null}
        </div>

        <div className="status-cell" aria-label="Analysis status">
          <span className={`status-badge ${status.className}`}>
            {status.label}
          </span>
          {run?.category ? (
            <span className="category-badge">
              {CATEGORY_DEFINITIONS[run.category].label}
            </span>
          ) : null}
          {run?.priority ? (
            <span className={`priority-badge ${priorityClass}`}>
              {titleCase(run.priority)}
            </span>
          ) : null}
        </div>

        <div className="received-cell">
          <time dateTime={message.received_at}>
            {formatReceivedAt(message.received_at)}
          </time>
          <span>{message.id}</span>
        </div>

        <div className="message-card-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={actionDisabled}
            aria-label={`${actionLabel} ${message.id}: ${subject}`}
            onClick={() => onAnalyze(message.id)}
          >
            {actionLabel}
          </button>
          <button
            type="button"
            className="text-button"
            aria-expanded={isExpanded}
            aria-controls={originalBodyId}
            aria-label={`${isExpanded ? "Hide" : "View"} original message for ${message.id}: ${subject}`}
            onClick={() => onToggleExpanded(message.id)}
          >
            {isExpanded ? "Hide original" : "Original"}
          </button>
        </div>
      </div>

      {isExpanded ? (
        <section
          className="original-message"
          id={originalBodyId}
          aria-label={`Original message from ${sender}`}
        >
          <div className="original-meta">
            <span>{titleCase(message.channel)}</span>
            <span>{organization ?? "No organization"}</span>
            <time dateTime={message.received_at}>
              {formatReceivedAt(message.received_at)}
            </time>
          </div>
          <p>{displayBody(message.body)}</p>
        </section>
      ) : null}
    </article>
  );
}
