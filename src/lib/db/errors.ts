export type PersistenceErrorCode =
  | "MESSAGE_NOT_FOUND"
  | "PROCESSING_RUN_EXISTS"
  | "RUN_NOT_FOUND"
  | "INVALID_RUN_TRANSITION"
  | "MIGRATION_CONFLICT"
  | "FIXTURE_INVALID"
  | "SEED_CONFLICT";

export class PersistenceError extends Error {
  override readonly name = "PersistenceError";

  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
