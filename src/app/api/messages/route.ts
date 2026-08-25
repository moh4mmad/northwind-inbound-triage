import { getDashboardData } from "@/lib/triage/dashboard-service";
import {
  assertLocalRequestHost,
  TriageRequestGuardError,
} from "@/lib/http/triage-request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This endpoint serves the local single-user UI. Any network deployment must
// add authenticated authorization before returning inbox contents.
export function GET(request: Request): Response {
  try {
    assertLocalRequestHost(request);
    return Response.json(getDashboardData(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof TriageRequestGuardError) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.safeMessage,
            retryable: false,
          },
        },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    console.error("Failed to load inbox", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      {
        error: {
          code: "INTERNAL",
          message: "The inbox could not be loaded.",
          retryable: true,
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
