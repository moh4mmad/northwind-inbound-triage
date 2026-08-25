export const DEFAULT_STALE_PROCESSING_MS = 5 * 60 * 1_000;
export const MIN_STALE_PROCESSING_MS = 30 * 1_000;
export const MAX_STALE_PROCESSING_MS = 24 * 60 * 60 * 1_000;

export function toIsoTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError("Timestamp must be a valid Date");
  }

  return value.toISOString();
}

export function assertStaleThreshold(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_STALE_PROCESSING_MS ||
    value > MAX_STALE_PROCESSING_MS
  ) {
    throw new RangeError(
      `Stale processing threshold must be an integer between ${MIN_STALE_PROCESSING_MS} and ${MAX_STALE_PROCESSING_MS} milliseconds`,
    );
  }

  return value;
}
