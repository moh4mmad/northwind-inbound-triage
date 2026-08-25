import { describe, expect, it } from "vitest";
import {
  assertValidTriageRequest,
  TriageRequestGuardError,
} from "@/lib/http/triage-request-guard";

interface RequestOptions {
  body?: string;
  contentLength?: string;
  contentType?: string;
  host?: string;
  origin?: string;
  requestHeader?: string;
}

function triageRequest(options: RequestOptions = {}): Request {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json; charset=utf-8",
    "X-Northwind-Request": options.requestHeader ?? "triage",
  });
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  if (options.contentLength !== undefined) {
    headers.set("Content-Length", options.contentLength);
  }

  return new Request(
    `http://${options.host ?? "localhost"}/api/messages/inb-001/triage`,
    {
      method: "POST",
      headers,
      body: options.body ?? "{}",
    },
  );
}

describe("assertValidTriageRequest", () => {
  it("accepts a same-origin JSON object request", async () => {
    const result = await assertValidTriageRequest(
      triageRequest({
        body: '{"source":"inbox"}',
        origin: "http://localhost",
      }),
    );

    expect(result).toEqual({ source: "inbox" });
  });

  it("allows an absent Origin header for non-browser local clients", async () => {
    await expect(assertValidTriageRequest(triageRequest())).resolves.toEqual(
      {},
    );
  });

  it.each([
    [
      { host: "attacker.example", origin: "http://attacker.example" },
      403,
      "NON_LOCAL_REQUEST",
    ],
    [{ origin: "https://attacker.example" }, 403, "CROSS_ORIGIN_REQUEST"],
    [{ contentType: "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    [{ requestHeader: "different-operation" }, 403, "MISSING_REQUEST_HEADER"],
    [{ body: "not-json" }, 400, "INVALID_JSON"],
    [{ body: "[]" }, 400, "INVALID_REQUEST_BODY"],
    [{ body: "null" }, 400, "INVALID_REQUEST_BODY"],
    [{ contentLength: "invalid" }, 400, "INVALID_CONTENT_LENGTH"],
    [{ contentLength: "1025" }, 413, "PAYLOAD_TOO_LARGE"],
  ] as const)(
    "rejects an unsafe request with %s",
    async (options, status, code) => {
      let caught: unknown;
      try {
        await assertValidTriageRequest(triageRequest(options));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TriageRequestGuardError);
      expect(caught).toMatchObject({ status, code });
    },
  );

  it("enforces the body limit even without Content-Length", async () => {
    await expect(
      assertValidTriageRequest(
        triageRequest({ body: `{"value":"${"x".repeat(1_100)}"}` }),
      ),
    ).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
  });
});
