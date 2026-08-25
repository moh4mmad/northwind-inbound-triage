import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceError } from "@/lib/db/errors";
import { applyMigrations } from "@/lib/db/migrations";
import type { AppDatabase } from "@/lib/db/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("applyMigrations", () => {
  it("re-checks migration state after acquiring the write lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "northwind-migration-"));
    temporaryDirectories.push(directory);
    const file = "001_test.sql";
    const sql = "CREATE TABLE should_not_run (id INTEGER PRIMARY KEY);";
    const checksum = createHash("sha256").update(sql).digest("hex");
    writeFileSync(join(directory, file), sql, "utf8");

    const findApplied = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ name: file, checksum });
    const recordApplied = vi.fn();
    const exec = vi.fn();
    const database = {
      exec,
      prepare: vi.fn((source: string) =>
        source.includes("SELECT name, checksum")
          ? { get: findApplied }
          : { run: recordApplied },
      ),
      transaction: vi.fn((operation: () => void) => ({
        immediate: operation,
      })),
    } as unknown as AppDatabase;

    applyMigrations(database, directory);

    expect(findApplied).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("schema_migrations"),
    );
    expect(recordApplied).not.toHaveBeenCalled();
  });

  it("still rejects checksum drift discovered under the write lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "northwind-migration-"));
    temporaryDirectories.push(directory);
    const file = "001_test.sql";
    const sql = "CREATE TABLE should_not_run (id INTEGER PRIMARY KEY);";
    writeFileSync(join(directory, file), sql, "utf8");

    const findApplied = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ name: file, checksum: "different-checksum" });
    const exec = vi.fn();
    const database = {
      exec,
      prepare: vi.fn((source: string) =>
        source.includes("SELECT name, checksum")
          ? { get: findApplied }
          : { run: vi.fn() },
      ),
      transaction: vi.fn((operation: () => void) => ({
        immediate: operation,
      })),
    } as unknown as AppDatabase;

    expect(() => applyMigrations(database, directory)).toThrowError(
      PersistenceError,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
