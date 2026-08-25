import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("local server boundary", () => {
  it("binds development and production servers to loopback", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.dev).toContain("--hostname 127.0.0.1");
    expect(packageJson.scripts?.start).toContain("--hostname 127.0.0.1");
  });

  it("sets the application security headers on every route", async () => {
    const entries = await nextConfig.headers?.();
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.source).toBe("/:path*");

    const headers = new Map(
      entries?.[0]?.headers.map(({ key, value }) => [key, value]),
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "object-src 'none'",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
