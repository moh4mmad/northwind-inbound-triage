import { describe, expect, it } from "vitest";
import {
  ANALYZE_ALL_CONCURRENCY,
  runWithConcurrency,
} from "@/components/queue-runner";

describe("runWithConcurrency", () => {
  it("limits work to three tasks and records a rejection without stopping the queue", async () => {
    let active = 0;
    let maxActive = 0;
    const visited: number[] = [];

    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      ANALYZE_ALL_CONCURRENCY,
      async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        visited.push(item);

        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (item === 2) throw new Error("Expected test failure");
        } finally {
          active -= 1;
        }
      },
    );

    expect(maxActive).toBe(3);
    expect(visited.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });
});
