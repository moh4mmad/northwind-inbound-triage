import type Database from "better-sqlite3";
import type { QualityReason, TriageResult } from "@/lib/domain/schemas";
import type { InputQuality, ProviderName } from "@/lib/domain/taxonomy";

export type AppDatabase = Database.Database;

export interface InitializeDbOptions {
  /** An existing connection owned by the caller. */
  database?: AppDatabase;
  /** A file path, or `:memory:`. Explicit paths return a caller-owned connection. */
  path?: string;
  fixturePath?: string;
  migrationsDirectory?: string;
  recoverStaleAfterMs?: number | false;
  now?: Date;
}

export interface CreateProcessingRunInput {
  messageId: string;
  inputQuality: InputQuality;
  reviewReasons: readonly QualityReason[];
  provider: ProviderName;
  model: string;
  promptVersion: string;
  attemptCount?: number;
  now?: Date;
}

export interface CompleteRunSuccessInput {
  status: "succeeded" | "needs_review";
  result: TriageResult;
  attemptCount?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  now?: Date;
}

export interface CompleteRunFailureInput {
  errorCode: string;
  errorMessage: string;
  attemptCount?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  now?: Date;
}

export interface StaleProcessingRecoveryOptions {
  olderThanMs?: number;
  now?: Date;
}
