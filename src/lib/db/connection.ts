import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { applyMigrations } from "./migrations";
import { recoverStaleProcessingRows } from "./maintenance";
import { seedInboundMessages } from "./seed";
import { DEFAULT_STALE_PROCESSING_MS, assertStaleThreshold } from "./time";
import type { AppDatabase, InitializeDbOptions } from "./types";

const BUSY_TIMEOUT_MS = 5_000;

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

function openDatabase(databasePath: string): AppDatabase {
  const normalizedPath = normalizePath(databasePath);
  if (normalizedPath !== ":memory:") {
    mkdirSync(dirname(normalizedPath), { recursive: true });
  }

  return new BetterSqlite3(normalizedPath);
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
    options.path ?? process.env.DATABASE_PATH ?? "./data/triage.sqlite",
  );
  const useSharedConnection = options.path === undefined;

  if (
    useSharedConnection &&
    globalForDatabase.__northwindDatabase?.path === configuredPath &&
    globalForDatabase.__northwindDatabase.database.open
  ) {
    return globalForDatabase.__northwindDatabase.database;
  }

  const database = openDatabase(configuredPath);
  try {
    prepareDatabase(database, options);
  } catch (error) {
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
