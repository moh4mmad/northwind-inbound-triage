import "server-only";

const REQUIRED_MEDIA_TYPE = "application/json";
const REQUIRED_REQUEST_HEADER = "x-northwind-request";
const REQUIRED_REQUEST_VALUE = "triage";
const MAX_REQUEST_BODY_BYTES = 1_024;

export type TriageRequestGuardErrorCode =
  | "CROSS_ORIGIN_REQUEST"
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_JSON"
  | "INVALID_REQUEST_BODY"
  | "MISSING_REQUEST_HEADER"
  | "NON_LOCAL_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE";

const ALLOWED_LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class TriageRequestGuardError extends Error {
  override readonly name = "TriageRequestGuardError";

  constructor(
    readonly status: 400 | 403 | 413 | 415,
    readonly code: TriageRequestGuardErrorCode,
    readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
  }
}

/**
 * Enforces the local UI's mutation contract before any paid provider work.
 * This is a same-origin/CSRF barrier, not authentication. A network deployment
 * must add authenticated authorization at the route boundary.
 */
export async function assertValidTriageRequest(
  request: Request,
): Promise<Record<string, unknown>> {
  assertLocalRequestHost(request);
  assertSameOrigin(request);
  assertMediaType(request);
  assertRequestHeader(request);

  const text = await readBoundedBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TriageRequestGuardError(
      400,
      "INVALID_JSON",
      "The request body must contain valid JSON.",
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new TriageRequestGuardError(
      400,
      "INVALID_REQUEST_BODY",
      "The request body must be a JSON object.",
    );
  }

  return parsed;
}

export function isAllowedLocalHostHeader(value: string | null): boolean {
  if (value === null || value.trim().length === 0) return false;

  try {
    const parsed = new URL(`http://${value.trim()}`);
    return (
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      ALLOWED_LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function assertLocalRequestHost(request: Request): void {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch (error) {
    throw nonLocalRequest(error);
  }

  if (!ALLOWED_LOCAL_HOSTNAMES.has(hostname)) {
    throw nonLocalRequest();
  }
}

function nonLocalRequest(cause?: unknown): TriageRequestGuardError {
  return new TriageRequestGuardError(
    403,
    "NON_LOCAL_REQUEST",
    "This local application does not accept requests for that host.",
    cause === undefined ? undefined : { cause },
  );
}

function assertSameOrigin(request: Request): void {
  const originHeader = request.headers.get("origin");
  if (originHeader === null) return;

  let requestOrigin: string;
  let suppliedOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
    suppliedOrigin = new URL(originHeader).origin;
  } catch (error) {
    throw new TriageRequestGuardError(
      403,
      "CROSS_ORIGIN_REQUEST",
      "Cross-origin analysis requests are not allowed.",
      { cause: error },
    );
  }

  if (requestOrigin !== suppliedOrigin) {
    throw new TriageRequestGuardError(
      403,
      "CROSS_ORIGIN_REQUEST",
      "Cross-origin analysis requests are not allowed.",
    );
  }
}

function assertMediaType(request: Request): void {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== REQUIRED_MEDIA_TYPE) {
    throw new TriageRequestGuardError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Analysis requests must use application/json.",
    );
  }
}

function assertRequestHeader(request: Request): void {
  if (
    request.headers.get(REQUIRED_REQUEST_HEADER)?.trim() !==
    REQUIRED_REQUEST_VALUE
  ) {
    throw new TriageRequestGuardError(
      403,
      "MISSING_REQUEST_HEADER",
      "The analysis request is missing its required application header.",
    );
  }
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new TriageRequestGuardError(
        400,
        "INVALID_CONTENT_LENGTH",
        "The request content length is invalid.",
      );
    }

    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new TriageRequestGuardError(
        400,
        "INVALID_CONTENT_LENGTH",
        "The request content length is invalid.",
      );
    }
    if (parsedLength > MAX_REQUEST_BODY_BYTES) {
      throw payloadTooLarge();
    }
  }

  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw payloadTooLarge();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }

  return text + decoder.decode();
}

function payloadTooLarge(): TriageRequestGuardError {
  return new TriageRequestGuardError(
    413,
    "PAYLOAD_TOO_LARGE",
    "The analysis request body is too large.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
