import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { applyMigrations } from "./migrations";
import { recoverStaleProcessingRows } from "./maintenance";
import { seedInboundMessages } from "./seed";
import { DEFAULT_STALE_PROCESSING_MS, assertStaleThreshold } from "./time";
import type { AppDatabase, InitializeDbOptions } from "./types";

const BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_DATABASE_PATH = "./data/triage.sqlite";
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

interface GlobalDatabaseState {
  database: AppDatabase;
  path: string;
}

const globalForDatabase = globalThis as typeof globalThis & {
  __northwindDatabase?: GlobalDatabaseState;
};

function normalizePath(databasePath: string): string {
  return databasePath === ":memory:" ? databasePath : resolve(databasePath);
}

function openDatabase(
  databasePath: string,
  secureDefaultDirectory: boolean,
): AppDatabase {
  const normalizedPath = normalizePath(databasePath);
  if (normalizedPath !== ":memory:") {
    const parentDirectory = dirname(normalizedPath);
    mkdirSync(parentDirectory, {
      recursive: true,
      mode: OWNER_ONLY_DIRECTORY_MODE,
    });
    if (secureDefaultDirectory) {
      restrictPermissions(
        parentDirectory,
        OWNER_ONLY_DIRECTORY_MODE,
        "database directory",
      );
    }
  }

  const database = new BetterSqlite3(normalizedPath);
  if (normalizedPath !== ":memory:") {
    restrictPermissions(normalizedPath, OWNER_ONLY_FILE_MODE, "database file");
  }
  return database;
}

function secureDatabaseArtifacts(databasePath: string): void {
  if (databasePath === ":memory:") return;

  restrictPermissions(databasePath, OWNER_ONLY_FILE_MODE, "database file");
  restrictPermissions(
    `${databasePath}-wal`,
    OWNER_ONLY_FILE_MODE,
    "database WAL file",
    true,
  );
  restrictPermissions(
    `${databasePath}-shm`,
    OWNER_ONLY_FILE_MODE,
    "database shared-memory file",
    true,
  );
}

function restrictPermissions(
  path: string,
  mode: number,
  artifact: string,
  allowMissing = false,
): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (allowMissing && readErrorCode(error) === "ENOENT") return;
    // Permission hardening is best-effort for filesystems without POSIX modes.
    // Do not print the configured path, which may itself contain private data.
    console.warn("Could not restrict local database permissions", {
      artifact,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function configureDatabase(database: AppDatabase): void {
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  if (!database.memory && !database.readonly) {
    database.pragma("journal_mode = WAL");
  }
}

function prepareDatabase(
  database: AppDatabase,
  options: InitializeDbOptions,
): void {
  configureDatabase(database);
  applyMigrations(database, options.migrationsDirectory, options.now);
  seedInboundMessages(database, options.fixturePath);

  const staleThreshold = options.recoverStaleAfterMs;
  if (staleThreshold !== false) {
    recoverStaleProcessingRows(
      database,
      assertStaleThreshold(staleThreshold ?? DEFAULT_STALE_PROCESSING_MS),
      options.now ?? new Date(),
    );
  }

  database.pragma("optimize");
}

export function initializeDb(options: InitializeDbOptions = {}): AppDatabase {
  if (options.database && options.path) {
    throw new TypeError("Pass either an existing database or a path, not both");
  }

  if (options.database) {
    prepareDatabase(options.database, options);
    return options.database;
  }

  const configuredPath = normalizePath(
    options.path ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
  );
  const useSharedConnection = options.path === undefined;
  const secureDefaultDirectory =
    options.path === undefined &&
    configuredPath === normalizePath(DEFAULT_DATABASE_PATH);

  if (
    useSharedConnection &&
    globalForDatabase.__northwindDatabase?.path === configuredPath &&
    globalForDatabase.__northwindDatabase.database.open
  ) {
    return globalForDatabase.__northwindDatabase.database;
  }

  const database = openDatabase(configuredPath, secureDefaultDirectory);
  try {
    prepareDatabase(database, options);
    secureDatabaseArtifacts(configuredPath);
  } catch (error) {
    secureDatabaseArtifacts(configuredPath);
    database.close();
    throw error;
  }

  if (useSharedConnection) {
    globalForDatabase.__northwindDatabase = {
      database,
      path: configuredPath,
    };
  }

  return database;
}
