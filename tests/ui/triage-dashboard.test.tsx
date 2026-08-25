/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriageDashboard } from "@/components/triage-dashboard";
import type {
  DashboardListResponse,
  DashboardMessage,
  DashboardTriageRun,
} from "@/lib/domain/dashboard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function message(id: string, subject: string, body: string): DashboardMessage {
  return {
    id,
    received_at: "2026-07-20T09:14:00-04:00",
    channel: "email",
    from_name: `Sender ${id.slice(-1)}`,
    from_org: "(individual)",
    subject,
    body,
    latestRun: null,
  };
}

function successfulRun(messageId: string): DashboardTriageRun {
  return {
    status: "succeeded",
    inputQuality: "valid",
    reviewReasons: ["unknown_organization"],
    summary: `Summary for ${messageId}.`,
    category: "prospect",
    priority: "medium",
    suggestedNextAction: `Review ${messageId} and arrange an introductory call.`,
    errorCode: null,
    errorMessage: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("TriageDashboard", () => {
  it("continues a batch after one failure and lets that row retry independently", async () => {
    const initialMessages = [
      message("inb-001", "Alpha request", "Original alpha message."),
      message("inb-002", "Beta request", "Original beta message."),
      message("inb-003", "Gamma request", "Original gamma message."),
    ];
    const attempts = new Map<string, number>();

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const match = String(input).match(
        /\/api\/messages\/(inb-\d{3})\/triage/u,
      );
      const messageId = match?.[1];
      if (!messageId) throw new Error("Unexpected request URL");

      const attempt = (attempts.get(messageId) ?? 0) + 1;
      attempts.set(messageId, attempt);

      if (messageId === "inb-002" && attempt === 1) {
        return jsonResponse(
          {
            error: {
              code: "provider_unavailable",
              message: "Provider temporarily unavailable.",
              retryable: true,
            },
          },
          503,
        );
      }

      const source = initialMessages.find((item) => item.id === messageId);
      if (!source) throw new Error("Unknown fixture message");

      return jsonResponse({
        message: {
          ...source,
          latestRun: successfulRun(messageId),
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const initialData: DashboardListResponse = {
      messages: initialMessages,
      provider: {
        name: "anthropic",
        model: "claude-sonnet-5",
        configured: true,
      },
    };

    render(<TriageDashboard initialData={initialData} />);

    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByText("Configured locally")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Analyze all" }));

    expect(await screen.findByText("Summary for inb-001.")).toBeInTheDocument();
    expect(await screen.findByText("Summary for inb-003.")).toBeInTheDocument();
    expect(
      await screen.findByText("Provider temporarily unavailable."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const retryButton = await screen.findByRole("button", {
      name: "Retry inb-002: Beta request",
    });
    await waitFor(() => expect(retryButton).toBeEnabled());
    fireEvent.click(retryButton);

    expect(await screen.findByText("Summary for inb-002.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("Provider temporarily unavailable."),
      ).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({
        method: "POST",
        body: "{}",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Northwind-Request": "triage",
        },
      });
    }
  });

  it("hides and stops counting a previous result when re-analysis fails", async () => {
    const source = message(
      "inb-001",
      "Alpha request",
      "Original alpha message.",
    );
    const previousRun = {
      ...successfulRun(source.id),
      summary: "Previous successful summary.",
      priority: "high" as const,
    };
    const initialMessage = { ...source, latestRun: previousRun };
    let attempt = 0;

    const fetchMock = vi.fn<typeof fetch>(async () => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse(
          {
            error: {
              code: "provider_unavailable",
              message: "Provider temporarily unavailable.",
              retryable: true,
            },
          },
          503,
        );
      }

      return jsonResponse({
        message: {
          ...source,
          latestRun: {
            ...successfulRun(source.id),
            summary: "Fresh successful summary.",
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TriageDashboard
        initialData={{
          messages: [initialMessage],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(
      screen.getByText("Previous successful summary."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "High 1" })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Analyze again inb-001: Alpha request",
      }),
    );

    expect(
      await screen.findByText("Provider temporarily unavailable."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Previous successful summary."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "High 0" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Failed 1" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/0 of 1/u).length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry inb-001: Alpha request",
      }),
    );

    expect(
      await screen.findByText("Fresh successful summary."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Provider temporarily unavailable."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Medium 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Failed 0" }),
    ).toBeInTheDocument();
  });

  it("uses a sanitized source preview before triage and labels model output distinctly", () => {
    const untriaged = message(
      "inb-001",
      "Alpha request",
      "First line\nSecond\tline\u0000with context.",
    );
    const analyzed = {
      ...message("inb-002", "Beta request", "Original beta body."),
      latestRun: successfulRun("inb-002"),
    };

    render(
      <TriageDashboard
        initialData={{
          messages: [untriaged, analyzed],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(
      screen.getByText("First line Second line�with context."),
    ).toBeInTheDocument();
    expect(screen.getByText("AI summary")).toBeInTheDocument();
    expect(screen.getByText("Summary for inb-002.")).toBeInTheDocument();
    expect(
      screen.queryByText(/Run analysis to generate/u),
    ).not.toBeInTheDocument();
  });

  it("neutralizes control and formatting characters in all visible source fields", () => {
    const source = {
      ...message(
        "inb-001",
        "Account\u0000update",
        "Body with a bidi marker\u202E and lone surrogate\uD800.",
      ),
      channel: "web\u0007-form",
      from_name: "Alice\u202Eadmin",
      from_org: "Harbor\u200BPartners",
    };

    render(
      <TriageDashboard
        initialData={{
          messages: [source],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(screen.getByText("Alice�admin")).toBeInTheDocument();
    expect(screen.getByText("Harbor�Partners")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Account�update" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Web� Form")).toBeInTheDocument();
    expect(
      screen.getByText("Body with a bidi marker� and lone surrogate�."),
    ).toBeInTheDocument();
  });

  it("searches source and triage fields while composing with queue filters", () => {
    const alpha = message(
      "inb-001",
      "Alpha request",
      "Original alpha message.",
    );
    const beta = {
      ...message("inb-002", "Beta request", "Original beta message."),
      from_org: "Harbor Partners",
      latestRun: successfulRun("inb-002"),
    };

    render(
      <TriageDashboard
        initialData={{
          messages: [alpha, beta],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    const search = screen.getByRole("searchbox", {
      name: "Search messages",
    });
    fireEvent.change(search, { target: { value: "Harbor Partners" } });

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Beta request" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Alpha request" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Medium 1" }));
    fireEvent.change(search, {
      target: { value: "Summary for inb-002" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "Original alpha" } });
    expect(
      screen.getByRole("heading", {
        name: "No messages match your search",
      }),
    ).toBeInTheDocument();

    const [clearSearchButton] = screen.getAllByRole("button", {
      name: "Clear search",
    });
    if (!clearSearchButton) throw new Error("Expected a clear search button");
    fireEvent.click(clearSearchButton);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "All 2" })).toBeInTheDocument();
  });

  it("shows normalized fallbacks while preserving access to the original body", () => {
    const initialData: DashboardListResponse = {
      messages: [
        {
          ...message("inb-010", "", "."),
          from_name: "",
          from_org: "(unknown)",
          channel: "web-form",
        },
      ],
      provider: {
        name: "anthropic",
        model: "claude-sonnet-5",
        configured: false,
      },
    };

    render(<TriageDashboard initialData={initialData} />);

    expect(screen.getByText("Unknown sender")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "No subject" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Analyze inb-010: No subject" }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "View original message for inb-010: No subject",
      }),
    );
    const originalMessage = screen.getByRole("region", {
      name: "Original message from Unknown sender",
    });
    expect(within(originalMessage).getByText(".")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Hide original message for inb-010: No subject",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("rejects malformed mutation responses instead of trusting partial data", async () => {
    const source = message("inb-001", "Alpha request", "Original message.");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ message: { id: source.id, latestRun: null } }),
      ),
    );

    render(
      <TriageDashboard
        initialData={{
          messages: [source],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Analyze inb-001: Alpha request" }),
    );

    expect(
      await screen.findByText(
        "The server returned an unexpected response. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Original message.")).toBeInTheDocument();
  });

  it("does not start a batch while an individual request is active", async () => {
    const source = message("inb-001", "Alpha request", "Original message.");
    let resolveRequest: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(() => pendingResponse);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TriageDashboard
        initialData={{
          messages: [source],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Analyze inb-001: Alpha request" }),
    );

    const analyzeAll = screen.getByRole("button", { name: "Analyze all" });
    await waitFor(() => expect(analyzeAll).toBeDisabled());
    fireEvent.click(analyzeAll);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveRequest?.(
      jsonResponse({
        message: { ...source, latestRun: successfulRun(source.id) },
      }),
    );
    expect(await screen.findByText("Summary for inb-001.")).toBeInTheDocument();
  });

  it("disables retries for persisted non-retryable failures", () => {
    const source = message("inb-001", "Alpha request", "Original message.");
    const failed: DashboardTriageRun = {
      ...successfulRun(source.id),
      status: "failed",
      summary: null,
      category: null,
      priority: null,
      suggestedNextAction: null,
      errorCode: "CONFIGURATION",
      errorMessage: "The selected AI provider is not configured correctly.",
    };

    render(
      <TriageDashboard
        initialData={{
          messages: [{ ...source, latestRun: failed }],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Cannot retry inb-001: Alpha request",
      }),
    ).toBeDisabled();
  });

  it("allows a manual retry after a persisted cancellation", () => {
    const source = message("inb-001", "Alpha request", "Original message.");
    const cancelled: DashboardTriageRun = {
      ...successfulRun(source.id),
      status: "failed",
      summary: null,
      category: null,
      priority: null,
      suggestedNextAction: null,
      errorCode: "CANCELLED",
      errorMessage: "The analysis was cancelled.",
    };

    render(
      <TriageDashboard
        initialData={{
          messages: [{ ...source, latestRun: cancelled }],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Retry inb-001: Alpha request",
      }),
    ).toBeEnabled();
  });

  it("batches retryable failures while skipping completed and permanent runs", async () => {
    const permanentSource = message(
      "inb-001",
      "Permanent failure",
      "Original message.",
    );
    const interruptedSource = message(
      "inb-002",
      "Interrupted work",
      "Original message.",
    );
    const completedSource = message(
      "inb-003",
      "Completed work",
      "Original message.",
    );
    const reviewSource = message(
      "inb-004",
      "Reviewed work",
      "Original message.",
    );
    const cancelledSource = message(
      "inb-005",
      "Cancelled work",
      "Original message.",
    );
    const permanent: DashboardTriageRun = {
      ...successfulRun(permanentSource.id),
      status: "failed",
      summary: null,
      category: null,
      priority: null,
      suggestedNextAction: null,
      errorCode: "CONFIGURATION",
      errorMessage: "The selected AI provider is not configured correctly.",
    };
    const interrupted: DashboardTriageRun = {
      ...permanent,
      errorCode: "PROCESS_INTERRUPTED",
      errorMessage:
        "Analysis was interrupted before it completed. Please retry.",
    };
    const completed = successfulRun(completedSource.id);
    const review: DashboardTriageRun = {
      ...successfulRun(reviewSource.id),
      status: "needs_review",
      reviewReasons: ["low_context"],
    };
    const cancelled: DashboardTriageRun = {
      ...permanent,
      errorCode: "CANCELLED",
      errorMessage: "The analysis was cancelled.",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const retriedSource = url.includes(interruptedSource.id)
        ? interruptedSource
        : cancelledSource;
      return jsonResponse({
        message: {
          ...retriedSource,
          latestRun: successfulRun(retriedSource.id),
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TriageDashboard
        initialData={{
          messages: [
            { ...permanentSource, latestRun: permanent },
            { ...interruptedSource, latestRun: interrupted },
            { ...completedSource, latestRun: completed },
            { ...reviewSource, latestRun: review },
            { ...cancelledSource, latestRun: cancelled },
          ],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Cannot retry inb-001: Permanent failure",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Retry inb-002: Interrupted work",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Retry inb-005: Cancelled work",
      }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Analyze all" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("inb-002"),
        expect.stringContaining("inb-005"),
      ]),
    );
    expect(requestedUrls.join(" ")).not.toMatch(/inb-001|inb-003|inb-004/u);
  });

  it("explains truncation and suspicious instructions on review rows", () => {
    const source = message("inb-001", "Long request", "Original message.");
    const reviewRun: DashboardTriageRun = {
      ...successfulRun(source.id),
      status: "needs_review",
      reviewReasons: ["prompt_truncated", "suspicious_instructions"],
    };

    render(
      <TriageDashboard
        initialData={{
          messages: [{ ...source, latestRun: reviewRun }],
          provider: {
            name: "anthropic",
            model: "claude-sonnet-5",
            configured: true,
          },
        }}
      />,
    );

    expect(
      screen.getByText(/only its beginning and end were analyzed/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/trying to influence its own triage/u),
    ).toBeInTheDocument();
  });
});
