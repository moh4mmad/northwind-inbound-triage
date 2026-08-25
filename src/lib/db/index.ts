import "server-only";

export { initializeDb } from "./connection";
export {
  completeRunFailure,
  completeRunSuccess,
  createProcessingRun,
  getMessageById,
  listMessageViews,
  recoverStaleProcessingRuns,
} from "./repository";
export { PersistenceError } from "./errors";
export {
  DEFAULT_STALE_PROCESSING_MS,
  MAX_STALE_PROCESSING_MS,
  MIN_STALE_PROCESSING_MS,
} from "./time";
export type {
  AppDatabase,
  CompleteRunFailureInput,
  CompleteRunSuccessInput,
  CreateProcessingRunInput,
  InitializeDbOptions,
  StaleProcessingRecoveryOptions,
} from "./types";
export type { PersistenceErrorCode } from "./errors";
