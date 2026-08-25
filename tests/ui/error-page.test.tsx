/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppErrorPage from "@/app/error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppErrorPage", () => {
  it("uses the App Router reset callback without exposing error details", () => {
    const reset = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorPage
        error={Object.assign(new Error("private database path"), {
          digest: "safe-digest",
        })}
        reset={reset}
      />,
    );

    expect(
      screen.queryByText(/private database path/u),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
