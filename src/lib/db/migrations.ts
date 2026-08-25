import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AppDatabase } from "./types";
import { PersistenceError } from "./errors";

interface MigrationRow {
  name: string;
  checksum: string;
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`;

export function applyMigrations(
  database: AppDatabase,
  migrationsDirectory = resolve(process.cwd(), "db/migrations"),
  now = new Date(),
): void {
  database.exec(CREATE_MIGRATIONS_TABLE);

  const files = readdirSync(migrationsDirectory)
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/u.test(file))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new PersistenceError(
      "MIGRATION_CONFLICT",
      "No database migrations were found",
    );
  }

  const findApplied = database.prepare(
    "SELECT name, checksum FROM schema_migrations WHERE name = ?",
  );
  const recordApplied = database.prepare(
    "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
  );

  for (const file of files) {
    const sql = readFileSync(resolve(migrationsDirectory, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = findApplied.get(file) as MigrationRow | undefined;

    if (applied) {
      assertMatchingMigration(applied, file, checksum);
      continue;
    }

    database
      .transaction(() => {
        // Another process may have applied this migration while this connection
        // waited for the write lock. Re-check after BEGIN IMMEDIATE before DDL.
        const concurrentlyApplied = findApplied.get(file) as
          MigrationRow | undefined;
        if (concurrentlyApplied) {
          assertMatchingMigration(concurrentlyApplied, file, checksum);
          return;
        }

        database.exec(sql);
        recordApplied.run(file, checksum, now.toISOString());
      })
      .immediate();
  }
}

function assertMatchingMigration(
  applied: MigrationRow,
  file: string,
  checksum: string,
): void {
  if (applied.checksum !== checksum) {
    throw new PersistenceError(
      "MIGRATION_CONFLICT",
      `Applied migration ${file} does not match the checked-in file`,
    );
  }
}
