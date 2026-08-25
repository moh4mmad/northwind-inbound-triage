import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  inboundMessageSchema,
  inboundMessagesSchema,
  type InboundMessage,
} from "@/lib/domain/schemas";
import { PersistenceError } from "./errors";
import type { AppDatabase } from "./types";

interface MessageRow {
  id: string;
  received_at: string;
  channel: string;
  from_name: string;
  from_org: string;
  subject: string;
  body: string;
}

function loadFixture(fixturePath: string): InboundMessage[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    return inboundMessagesSchema.parse(parsed);
  } catch (error) {
    throw new PersistenceError(
      "FIXTURE_INVALID",
      "The inbound message fixture is not valid",
      { cause: error },
    );
  }
}

function messagesMatch(left: InboundMessage, right: InboundMessage): boolean {
  return (
    left.id === right.id &&
    left.received_at === right.received_at &&
    left.channel === right.channel &&
    left.from_name === right.from_name &&
    left.from_org === right.from_org &&
    left.subject === right.subject &&
    left.body === right.body
  );
}

export function seedInboundMessages(
  database: AppDatabase,
  fixturePath = resolve(process.cwd(), "data/inbound.json"),
): void {
  const messages = loadFixture(fixturePath);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO messages (
      id,
      received_at,
      channel,
      from_name,
      from_org,
      subject,
      body
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findById = database.prepare(`
    SELECT id, received_at, channel, from_name, from_org, subject, body
    FROM messages
    WHERE id = ?
  `);

  database
    .transaction(() => {
      for (const message of messages) {
        insert.run(
          message.id,
          message.received_at,
          message.channel,
          message.from_name,
          message.from_org,
          message.subject,
          message.body,
        );

        const storedRow = findById.get(message.id) as MessageRow | undefined;
        const stored = storedRow ? inboundMessageSchema.parse(storedRow) : null;
        if (!stored || !messagesMatch(stored, message)) {
          throw new PersistenceError(
            "SEED_CONFLICT",
            `Seeded message ${message.id} differs from the immutable fixture`,
          );
        }
      }
    })
    .immediate();
}
