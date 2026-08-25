"use client";

import { useEffect } from "react";

export default function AppErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Inbox render failed", { digest: error.digest });
  }, [error]);

  return (
    <main className="fatal-state">
      <p className="eyebrow">Northwind Advisors</p>
      <h1>The inbox could not be loaded</h1>
      <p>
        Your messages are still stored. Try loading the local workspace again.
      </p>
      <button className="primary-button" type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
