export const ANALYZE_ALL_CONCURRENCY = 3;

/**
 * Runs every task with a fixed worker count and preserves each outcome.
 * A rejected task is recorded instead of stopping another queued item.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }

  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        await task(items[currentIndex] as T);
        results[currentIndex] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
