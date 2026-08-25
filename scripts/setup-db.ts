import nextEnv from "@next/env";
import { initializeDb } from "../src/lib/db/connection";

nextEnv.loadEnvConfig(process.cwd());

const database = initializeDb({
  path: process.env.DATABASE_PATH ?? "./data/triage.sqlite",
});

try {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM messages")
    .get() as { count: number };
  console.log(
    `Database ready with ${row.count} inbound messages at ${database.name}`,
  );
} finally {
  database.pragma("optimize");
  database.close();
}
