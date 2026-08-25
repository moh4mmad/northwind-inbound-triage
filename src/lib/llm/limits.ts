export const MAX_PROVIDER_ATTEMPT_TIMEOUT_MS = 180_000;
export const MAX_PROVIDER_OVERALL_TIMEOUT_MS = 240_000;
export const MAX_PROVIDER_RETRY_AFTER_MS = 30_000;
export const MAX_PROVIDER_ATTEMPTS = 3;

export const DEFAULT_PROVIDER_OVERALL_TIMEOUT_MS = 240_000;

export const DEFAULT_PROVIDER_TIMEOUT_MS = {
  anthropic: 30_000,
  openai: 30_000,
  // Bedrock can add cold-start latency while compiling a structured-output
  // grammar, so its attempt budget is intentionally larger.
  bedrock: 180_000,
} as const;
