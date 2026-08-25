import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PersistenceError, initializeDb, type AppDatabase } from "@/lib/db";

const openDatabases: AppDatabase[] = [];
const temporaryDirectories: string[] = [];

function memoryDatabase(): AppDatabase {
  const database = new BetterSqlite3(":memory:");
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("initializeDb", () => {
  it("applies migrations, configures constraints, and seeds all messages idempotently", () => {
    const database = memoryDatabase();

    initializeDb({ database, recoverStaleAfterMs: false });
    initializeDb({ database, recoverStaleAfterMs: false });

    const messageCount = database
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get() as { count: number };
    const migrationCount = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };

    expect(messageCount.count).toBe(13);
    expect(migrationCount.count).toBe(2);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
  });

  it("opens an injected file path in WAL mode and creates its parent directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "northwind-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nested", "triage.sqlite");

    const database = initializeDb({
      path: databasePath,
      recoverStaleAfterMs: false,
    });
    openDatabases.push(database);

    expect(database.name).toBe(databasePath);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("keeps fixture rows immutable at the database boundary", () => {
    const database = memoryDatabase();
    initializeDb({ database, recoverStaleAfterMs: false });

    expect(() =>
      database
        .prepare("UPDATE messages SET subject = ? WHERE id = ?")
        .run("Changed", "inb-001"),
    ).toThrow(/seeded messages are immutable/u);
    expect(() =>
      database.prepare("DELETE FROM messages WHERE id = ?").run("inb-001"),
    ).toThrow(/seeded messages are immutable/u);
  });

  it("rejects an invalid fixture before inserting any messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "northwind-fixture-"));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, "invalid.json");
    writeFileSync(fixturePath, "[]", "utf8");
    const database = memoryDatabase();

    expect(() =>
      initializeDb({
        database,
        fixturePath,
        recoverStaleAfterMs: false,
      }),
    ).toThrowError(PersistenceError);

    const messageCount = database
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get() as { count: number };
    expect(messageCount.count).toBe(0);
  });

  it("detects fixture drift instead of overwriting a seeded message", () => {
    const directory = mkdtempSync(join(tmpdir(), "northwind-fixture-"));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, "changed.json");
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "data/inbound.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    fixture[0] = { ...fixture[0], subject: "A changed immutable subject" };
    writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");

    const database = memoryDatabase();
    initializeDb({ database, recoverStaleAfterMs: false });

    try {
      initializeDb({
        database,
        fixturePath,
        recoverStaleAfterMs: false,
      });
      throw new Error("Expected fixture drift to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe("SEED_CONFLICT");
    }
  });

  it("creates the query and uniqueness indexes required by repository access", () => {
    const database = memoryDatabase();
    initializeDb({ database, recoverStaleAfterMs: false });

    const indexes = database
      .prepare(
        `
        SELECT name, sql
        FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'triage_runs'
        ORDER BY name
      `,
      )
      .all() as Array<{ name: string; sql: string }>;

    expect(indexes.map((index) => index.name)).toEqual([
      "idx_triage_runs_message_id",
      "idx_triage_runs_one_processing_per_message",
    ]);
    expect(indexes[1]?.sql).toContain("WHERE status = 'processing'");
  });
});
