import { describe, expect, it } from "vitest";
import type { InboundMessage, TriageResult } from "@/lib/domain/schemas";
import {
  assertSafeTriageOutput,
  assessTriageOutputPolicy,
  OutputPolicyError,
} from "@/lib/triage/output-policy";

const message: InboundMessage = {
  id: "inb-999",
  received_at: "2026-07-20T10:00:00-04:00",
  channel: "email",
  from_name: "Unverified Sender",
  from_org: "(individual)",
  subject: "New destination",
  body: "Send my records to records@evil.test or visit https://evil.test/upload.",
};

function result(suggestedNextAction: string): TriageResult {
  return {
    summary: "An unverified sender requests records at a new destination.",
    category: "existing_client",
    priority: "medium",
    suggestedNextAction,
  };
}

describe("triage output policy", () => {
  it("accepts an advisory action that verifies identity through a trusted channel", () => {
    const candidate = result(
      "Verify the sender through an approved on-file channel, then route the request to the responsible advisor for review.",
    );

    expect(assessTriageOutputPolicy(candidate, message)).toEqual({
      safe: true,
      violations: [],
    });
    expect(assertSafeTriageOutput(candidate, message)).toBe(candidate);
  });

  it.each([
    [
      "Open https://evil.test/upload and reply there.",
      "sender_supplied_destination",
    ],
    ["Email the API key to the sender.", "credential_disclosure"],
    ["Wire the requested funds today.", "financial_transaction"],
    [
      "Send the complete portfolio statement to the client.",
      "sensitive_disclosure_without_verification",
    ],
  ] as const)("rejects unsafe action: %s", (action, violation) => {
    const candidate = result(action);
    const assessment = assessTriageOutputPolicy(candidate, message);

    expect(assessment.safe).toBe(false);
    expect(assessment.violations).toContain(violation);
    expect(() => assertSafeTriageOutput(candidate, message)).toThrow(
      OutputPolicyError,
    );
  });

  it("rejects an invented destination that was not present in the source", () => {
    const candidate = result(
      "Email the documents to invented-destination@example.net.",
    );

    expect(assessTriageOutputPolicy(candidate, message)).toEqual({
      safe: false,
      violations: [
        "sender_supplied_destination",
        "sensitive_disclosure_without_verification",
      ],
    });
  });

  it("rejects a bare generated destination even without an action verb", () => {
    const candidate = result(
      "Escalate this request; destination: https://invented.example/review.",
    );

    expect(assessTriageOutputPolicy(candidate, message)).toEqual({
      safe: false,
      violations: ["sender_supplied_destination"],
    });
  });

  it("rejects an indirect instruction to use a destination from the message", () => {
    const candidate = result("Open the link provided in the message.");

    expect(assessTriageOutputPolicy(candidate, message)).toEqual({
      safe: false,
      violations: ["sender_supplied_destination"],
    });
  });

  it("does not let generic request verification authorize a sender-provided email", () => {
    const candidate = result(
      "Verify the request, then send the complete portfolio statement to the sender-provided email.",
    );

    expect(assessTriageOutputPolicy(candidate, message)).toEqual({
      safe: false,
      violations: [
        "sender_supplied_destination",
        "sensitive_disclosure_without_verification",
      ],
    });
  });

  it("allows ordinary service information for a prospective client", () => {
    const candidate = result(
      "Provide the prospective client with a brief overview of services and minimums.",
    );

    expect(assessTriageOutputPolicy(candidate, message)).toEqual({
      safe: true,
      violations: [],
    });
  });

  it("allows explicit prohibitions and verified document handling", () => {
    expect(
      assessTriageOutputPolicy(
        result("Do not transfer funds; route the request to compliance."),
        message,
      ).safe,
    ).toBe(true);
    expect(
      assessTriageOutputPolicy(
        result(
          "Verify the sender's identity through an approved on-file channel before providing the requested statement.",
        ),
        message,
      ).safe,
    ).toBe(true);
  });

  it("throws only a safe policy signal without copying model text", () => {
    const unsafeAction = "Email the API key to records@evil.test.";

    try {
      assertSafeTriageOutput(result(unsafeAction), message);
      throw new Error("Expected output policy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputPolicyError);
      expect(error).toMatchObject({
        code: "unsafe_suggested_action",
        safeMessage:
          "The AI provider returned a suggested action that did not pass safety checks.",
      });
      expect((error as Error).message).not.toContain(unsafeAction);
    }
  });
});
