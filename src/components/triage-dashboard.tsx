"use client";

import { useMemo, useRef, useState } from "react";
import {
  dashboardMessageSchema,
  isPersistedRunRetryable,
  type DashboardListResponse,
  type DashboardMessage,
} from "@/lib/domain/dashboard";
import type { ProviderName } from "@/lib/domain/taxonomy";
import { MessageCard, type VisibleTriageError } from "./message-card";
import { ANALYZE_ALL_CONCURRENCY, runWithConcurrency } from "./queue-runner";

type FilterKey =
  "all" | "untriaged" | "high" | "medium" | "low" | "needs_review" | "failed";

interface FilterDefinition {
  key: FilterKey;
  label: string;
}

interface BatchProgress {
  completed: number;
  failed: number;
  running: boolean;
  total: number;
}

const FILTERS: readonly FilterDefinition[] = [
  { key: "all", label: "All" },
  { key: "untriaged", label: "Untriaged" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "needs_review", label: "Needs review" },
  { key: "failed", label: "Failed" },
];

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Claude via Anthropic",
  openai: "OpenAI",
  bedrock: "Claude via Bedrock",
};

class RequestShapeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMessageResponse(
  value: unknown,
  expectedId: string,
): DashboardMessage {
  if (!isRecord(value)) {
    throw new RequestShapeError("Missing message response");
  }

  const parsed = dashboardMessageSchema.safeParse(value.message);
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw new RequestShapeError("Unexpected message response");
  }

  return parsed.data;
}

function safeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const message = value.trim().slice(0, 280);
  return message || fallback;
}

async function readFailure(response: Response): Promise<VisibleTriageError> {
  const fallback = `The analysis request failed with status ${response.status}.`;

  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.error)) {
      return { code: "request_failed", message: fallback, retryable: true };
    }

    return {
      code:
        typeof body.error.code === "string"
          ? body.error.code
          : "request_failed",
      message: safeErrorMessage(body.error.message, fallback),
      retryable:
        typeof body.error.retryable === "boolean" ? body.error.retryable : true,
    };
  } catch {
    return { code: "request_failed", message: fallback, retryable: true };
  }
}

function requestError(error: unknown): VisibleTriageError {
  if (error instanceof RequestShapeError) {
    return {
      code: "invalid_response",
      message: "The server returned an unexpected response. Please try again.",
      retryable: true,
    };
  }

  return {
    code: "network_error",
    message:
      "The server could not be reached. Check your connection and try again.",
    retryable: true,
  };
}

function hasClientError(
  messageId: string,
  errors: Readonly<Record<string, VisibleTriageError>>,
): boolean {
  return errors[messageId] !== undefined;
}

function currentRun(
  message: DashboardMessage,
  errors: Readonly<Record<string, VisibleTriageError>>,
): DashboardMessage["latestRun"] {
  return hasClientError(message.id, errors) ? null : message.latestRun;
}

function matchesFilter(
  message: DashboardMessage,
  filter: FilterKey,
  errors: Readonly<Record<string, VisibleTriageError>>,
): boolean {
  const clientFailed = hasClientError(message.id, errors);
  const run = currentRun(message, errors);
  const failed = clientFailed || message.latestRun?.status === "failed";

  switch (filter) {
    case "all":
      return true;
    case "untriaged":
      return run === null && !failed;
    case "high":
    case "medium":
    case "low":
      return run?.priority === filter;
    case "needs_review":
      return run?.status === "needs_review";
    case "failed":
      return failed;
  }
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function matchesSearch(
  message: DashboardMessage,
  query: string,
  errors: Readonly<Record<string, VisibleTriageError>>,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const run = currentRun(message, errors);
  const error = errors[message.id];
  const searchableText = [
    message.id,
    message.received_at,
    message.channel,
    message.from_name,
    message.from_org,
    message.subject,
    message.body,
    run?.status,
    run?.inputQuality,
    run?.reviewReasons.join(" "),
    run?.summary,
    run?.category,
    run?.priority,
    run?.suggestedNextAction,
    error?.code,
    error?.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return normalizeSearchText(searchableText).includes(normalizedQuery);
}

function shouldAnalyze(
  message: DashboardMessage,
  errors: Readonly<Record<string, VisibleTriageError>>,
): boolean {
  const clientError = errors[message.id];
  if (clientError) return clientError.retryable;

  const run = message.latestRun;
  return (
    run === null ||
    (run.status === "failed" && isPersistedRunRetryable(run.errorCode))
  );
}

function updateIdSet(
  current: ReadonlySet<string>,
  messageId: string,
  include: boolean,
): Set<string> {
  const next = new Set(current);
  if (include) next.add(messageId);
  else next.delete(messageId);
  return next;
}

export interface TriageDashboardProps {
  initialData: DashboardListResponse;
}

export function TriageDashboard({ initialData }: TriageDashboardProps) {
  const [messages, setMessages] = useState(initialData.messages);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [errors, setErrors] = useState<Record<string, VisibleTriageError>>({});
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
  const [queuedIds, setQueuedIds] = useState<Set<string>>(() => new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState("");
  const inFlightIds = useRef(new Set<string>());
  const requestGenerations = useRef(new Map<string, number>());

  const batchRunning = batchProgress?.running === true;
  const providerLabel = PROVIDER_LABELS[initialData.provider.name];
  const hasSearchQuery = searchQuery.trim().length > 0;

  const searchMatchedMessages = useMemo(
    () =>
      messages.filter((message) => matchesSearch(message, searchQuery, errors)),
    [errors, messages, searchQuery],
  );

  const filterCounts = useMemo(() => {
    return Object.fromEntries(
      FILTERS.map(({ key }) => [
        key,
        searchMatchedMessages.filter((message) =>
          matchesFilter(message, key, errors),
        ).length,
      ]),
    ) as Record<FilterKey, number>;
  }, [errors, searchMatchedMessages]);

  const visibleMessages = useMemo(
    () =>
      searchMatchedMessages.filter((message) =>
        matchesFilter(message, filter, errors),
      ),
    [errors, filter, searchMatchedMessages],
  );

  const summary = useMemo(
    () => ({
      high: messages.filter(
        (message) => currentRun(message, errors)?.priority === "high",
      ).length,
      needsReview: messages.filter(
        (message) => currentRun(message, errors)?.status === "needs_review",
      ).length,
      triaged: messages.filter((message) => {
        const run = currentRun(message, errors);
        return run?.status === "succeeded" || run?.status === "needs_review";
      }).length,
    }),
    [errors, messages],
  );

  const analyzableMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          shouldAnalyze(message, errors) &&
          !activeIds.has(message.id) &&
          !queuedIds.has(message.id),
      ),
    [activeIds, errors, messages, queuedIds],
  );

  async function analyzeMessage(
    messageId: string,
    announce = true,
  ): Promise<boolean> {
    if (inFlightIds.current.has(messageId)) return false;

    inFlightIds.current.add(messageId);
    const generation = (requestGenerations.current.get(messageId) ?? 0) + 1;
    requestGenerations.current.set(messageId, generation);
    setActiveIds((current) => updateIdSet(current, messageId, true));

    try {
      const response = await fetch(
        `/api/messages/${encodeURIComponent(messageId)}/triage`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Northwind-Request": "triage",
          },
          body: "{}",
        },
      );

      if (!response.ok) {
        const nextError = await readFailure(response);
        if (requestGenerations.current.get(messageId) !== generation) {
          return false;
        }
        setErrors((current) => ({ ...current, [messageId]: nextError }));
        if (announce)
          setAnnouncement(
            `Analysis failed for ${messageId}. ${nextError.message}`,
          );
        return false;
      }

      const body: unknown = await response.json();
      const nextMessage = parseMessageResponse(body, messageId);
      if (requestGenerations.current.get(messageId) !== generation) {
        return false;
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? nextMessage : message,
        ),
      );
      setErrors((current) => {
        if (!current[messageId]) return current;
        const next = { ...current };
        delete next[messageId];
        return next;
      });
      if (announce) setAnnouncement(`Analysis completed for ${messageId}.`);
      return true;
    } catch (error) {
      const nextError = requestError(error);
      if (requestGenerations.current.get(messageId) !== generation) {
        return false;
      }
      setErrors((current) => ({ ...current, [messageId]: nextError }));
      if (announce)
        setAnnouncement(
          `Analysis failed for ${messageId}. ${nextError.message}`,
        );
      return false;
    } finally {
      if (requestGenerations.current.get(messageId) === generation) {
        inFlightIds.current.delete(messageId);
        setActiveIds((current) => updateIdSet(current, messageId, false));
      }
    }
  }

  async function analyzeAll(): Promise<void> {
    if (
      batchRunning ||
      activeIds.size > 0 ||
      queuedIds.size > 0 ||
      !initialData.provider.configured
    ) {
      return;
    }

    const messageIds = analyzableMessages.map((message) => message.id);
    if (messageIds.length === 0) return;

    let completed = 0;
    let failed = 0;
    setQueuedIds(new Set(messageIds));
    setBatchProgress({
      completed: 0,
      failed: 0,
      running: true,
      total: messageIds.length,
    });
    setAnnouncement(`Starting analysis for ${messageIds.length} messages.`);

    await runWithConcurrency(
      messageIds,
      ANALYZE_ALL_CONCURRENCY,
      async (messageId) => {
        setQueuedIds((current) => updateIdSet(current, messageId, false));
        const succeeded = await analyzeMessage(messageId, false);
        completed += 1;
        if (!succeeded) failed += 1;
        setBatchProgress({
          completed,
          failed,
          running: true,
          total: messageIds.length,
        });
      },
    );

    setQueuedIds(new Set());
    setBatchProgress({
      completed,
      failed,
      running: false,
      total: messageIds.length,
    });
    setAnnouncement(
      `Analysis finished. ${messageIds.length - failed} succeeded and ${failed} ${failed === 1 ? "failed" : "failed"}.`,
    );
  }

  function toggleExpanded(messageId: string): void {
    setExpandedIds((current) =>
      updateIdSet(current, messageId, !current.has(messageId)),
    );
  }

  const batchLabel = batchRunning
    ? `Analyzing ${batchProgress.completed} of ${batchProgress.total}`
    : "Analyze all";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            NW
          </span>
          <div className="title-block">
            <p className="eyebrow">Northwind Advisors</p>
            <h1>Inbound triage</h1>
          </div>
        </div>

        <div className="header-actions">
          <div
            className={`provider-pill ${initialData.provider.configured ? "provider-configured" : "provider-unconfigured"}`}
            title={
              initialData.provider.configured
                ? "Provider settings are present locally; credentials are checked when analysis runs"
                : "Provider configuration is incomplete"
            }
          >
            <span className="provider-dot" aria-hidden="true" />
            <span>
              <strong>{providerLabel}</strong>
              <small>{initialData.provider.model}</small>
            </span>
            <span className="provider-state">
              {initialData.provider.configured
                ? "Configured locally"
                : "Not configured"}
            </span>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={
              batchRunning ||
              activeIds.size > 0 ||
              queuedIds.size > 0 ||
              !initialData.provider.configured ||
              analyzableMessages.length === 0
            }
            onClick={() => void analyzeAll()}
          >
            {batchLabel}
          </button>
        </div>
      </header>

      {!initialData.provider.configured ? (
        <aside className="configuration-notice" role="status">
          <strong>Provider setup required.</strong>
          <span>
            Add valid credentials and model settings for {providerLabel} to
            .env.local, then restart the app.
          </span>
        </aside>
      ) : null}

      <section className="queue-controls" aria-label="Queue controls">
        <div className="queue-overview">
          <div className="queue-heading">
            <h2>Inbox</h2>
            <span>
              Showing {visibleMessages.length} of {messages.length}
            </span>
          </div>

          <dl className="queue-stats" aria-label="Queue overview">
            <div>
              <dt>Total</dt>
              <dd>{messages.length}</dd>
            </div>
            <div>
              <dt>High</dt>
              <dd>{summary.high}</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>{summary.needsReview}</dd>
            </div>
          </dl>

          <div className="queue-progress">
            <div>
              <span>Triaged</span>
              <strong>
                {summary.triaged} of {messages.length}
              </strong>
            </div>
            <progress
              aria-label="Messages triaged"
              max={messages.length || 1}
              value={summary.triaged}
            >
              {summary.triaged} of {messages.length}
            </progress>
            {batchProgress ? (
              <p aria-live="polite" aria-atomic="true">
                {batchProgress.running
                  ? `${batchProgress.completed} of ${batchProgress.total} complete`
                  : `${batchProgress.total - batchProgress.failed} succeeded, ${batchProgress.failed} failed`}
              </p>
            ) : null}
          </div>
        </div>

        <div className="filter-row">
          <nav className="filters" aria-label="Filter messages">
            {FILTERS.map(({ key, label }) => (
              <button
                type="button"
                key={key}
                className={filter === key ? "filter-active" : undefined}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label} <span>{filterCounts[key]}</span>
              </button>
            ))}
          </nav>
          <div className="filter-tools">
            {batchRunning ? (
              <span className="concurrency-copy">
                Up to {ANALYZE_ALL_CONCURRENCY} at once
              </span>
            ) : null}
            <div className="search-control">
              <label className="sr-only" htmlFor="message-search">
                Search messages
              </label>
              <input
                id="message-search"
                type="search"
                value={searchQuery}
                maxLength={200}
                autoComplete="off"
                placeholder="Search inbox"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              {hasSearchQuery ? (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery("")}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {visibleMessages.length > 0 ? (
        <section className="inbox-surface" aria-label="Inbound messages">
          <div className="inbox-column-head" aria-hidden="true">
            <span>Sender</span>
            <span>Message</span>
            <span>Triage</span>
            <span>Received</span>
            <span>Actions</span>
          </div>
          <div className="message-list">
            {visibleMessages.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                error={errors[message.id]}
                isActive={activeIds.has(message.id)}
                isQueued={queuedIds.has(message.id)}
                isBatchRunning={batchRunning}
                isConfigured={initialData.provider.configured}
                isExpanded={expandedIds.has(message.id)}
                onAnalyze={(messageId) => void analyzeMessage(messageId)}
                onToggleExpanded={toggleExpanded}
              />
            ))}
          </div>
        </section>
      ) : (
        <section className="empty-filter" aria-live="polite">
          <h2>
            {hasSearchQuery
              ? "No messages match your search"
              : "No messages match this filter"}
          </h2>
          <p>
            {hasSearchQuery
              ? "Try another term or clear the search to return to the queue."
              : "Choose another queue view to continue reviewing messages."}
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              if (hasSearchQuery) setSearchQuery("");
              else setFilter("all");
            }}
          >
            {hasSearchQuery ? "Clear search" : "Show all messages"}
          </button>
        </section>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </main>
  );
}
