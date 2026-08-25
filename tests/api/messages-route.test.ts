import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDashboardDataMock } = vi.hoisted(() => ({
  getDashboardDataMock: vi.fn(),
}));

vi.mock("@/lib/triage/dashboard-service", () => ({
  getDashboardData: getDashboardDataMock,
}));

import { GET } from "@/app/api/messages/route";

beforeEach(() => {
  getDashboardDataMock.mockReset().mockReturnValue({
    messages: [],
    provider: {
      name: "anthropic",
      model: "claude-sonnet-5",
      configured: true,
    },
  });
});

describe("GET /api/messages", () => {
  it("serves the inbox only for an allowed local hostname", async () => {
    const response = GET(new Request("http://localhost/api/messages"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ messages: [] });
    expect(getDashboardDataMock).toHaveBeenCalledOnce();
  });

  it("rejects a DNS-rebinding hostname before reading inbox data", async () => {
    const response = GET(
      new Request("http://attacker.example:3000/api/messages"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NON_LOCAL_REQUEST",
        message:
          "This local application does not accept requests for that host.",
        retryable: false,
      },
    });
    expect(getDashboardDataMock).not.toHaveBeenCalled();
  });
});
