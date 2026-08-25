import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inboundMessagesSchema,
  triageResultSchema,
  triageWireJsonSchema,
  type InboundMessage,
} from "@/lib/domain/schemas";

function loadFixture(): InboundMessage[] {
  const raw = JSON.parse(
    readFileSync(resolve("data/inbound.json"), "utf8"),
  ) as unknown;
  return inboundMessagesSchema.parse(raw);
}

describe("inboundMessagesSchema", () => {
  it("accepts all 13 supplied records and preserves deliberate NUL bytes", () => {
    const messages = loadFixture();

    expect(messages).toHaveLength(13);
    expect(messages.find((message) => message.id === "inb-005")?.subject).toBe(
      "",
    );
    expect(
      messages
        .find((message) => message.id === "inb-011")
        ?.body.startsWith("\u0000\u0000"),
    ).toBe(true);
  });

  it("rejects duplicate IDs", () => {
    const messages = loadFixture();
    expect(() =>
      inboundMessagesSchema.parse([...messages, messages[0]]),
    ).toThrow(/Duplicate message id/u);
  });
});

describe("triageResultSchema", () => {
  const validResult = {
    summary: "Client needs a statement by Friday.",
    category: "existing_client",
    priority: "high",
    suggestedNextAction:
      "Assign an advisor to send the requested statement today.",
  } as const;

  it("accepts the exact structured contract", () => {
    expect(triageResultSchema.parse(validResult)).toEqual(validResult);
  });

  it.each([
    { ...validResult, category: "sales" },
    { ...validResult, priority: "urgent" },
    { ...validResult, summary: "First line\nSecond line" },
    {
      ...validResult,
      suggestedNextAction: "First action\nSecond action",
    },
    { ...validResult, summary: "Client says\u202E safe" },
    { ...validResult, suggestedNextAction: "Review\u200B account" },
    { ...validResult, extra: true },
    { ...validResult, suggestedNextAction: "" },
  ])("rejects malformed model output", (candidate) => {
    expect(triageResultSchema.safeParse(candidate).success).toBe(false);
  });

  it("keeps provider JSON Schema bounds aligned with local result bounds", () => {
    expect(triageWireJsonSchema.properties.summary).toMatchObject({
      minLength: 1,
      maxLength: 240,
      pattern: "^[^\\r\\n]+$",
    });
    expect(triageWireJsonSchema.properties.suggestedNextAction).toMatchObject({
      minLength: 1,
      maxLength: 400,
      pattern: "^[^\\r\\n]+$",
    });
  });
});
