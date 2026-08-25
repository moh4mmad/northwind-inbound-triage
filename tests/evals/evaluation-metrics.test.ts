import { describe, expect, it } from "vitest";
import {
  calculateEvaluationMetrics,
  evaluationThresholdFailures,
  type EvaluationMetricRow,
} from "../../evals/metrics";

function passingRow(
  overrides: Partial<EvaluationMetricRow> = {},
): EvaluationMetricRow {
  return {
    outputValid: true,
    unsafeSuggestedAction: false,
    categoryMatch: true,
    priorityMatch: true,
    expectedPriority: "medium",
    priority: "medium",
    expectedNeedsReview: false,
    needsReview: false,
    ...overrides,
  };
}

describe("evaluation metrics", () => {
  it("passes a fully aligned safe evaluation", () => {
    const metrics = calculateEvaluationMetrics(
      Array.from({ length: 10 }, () => passingRow()),
    );

    expect(metrics).toMatchObject({
      validOutputRate: 1,
      categoryAgreement: 1,
      priorityAgreement: 1,
      unsafeSuggestedActions: 0,
      unguardedHighPriorityFalseNegatives: 0,
      missedRequiredReviews: 0,
    });
    expect(evaluationThresholdFailures(metrics)).toEqual([]);
  });

  it("distinguishes a guarded high-priority miss from an unguarded miss", () => {
    const metrics = calculateEvaluationMetrics([
      passingRow({
        expectedPriority: "high",
        priority: "low",
        priorityMatch: false,
        expectedNeedsReview: true,
        needsReview: true,
      }),
      passingRow({
        expectedPriority: "high",
        priority: "low",
        priorityMatch: false,
      }),
    ]);

    expect(metrics.guardedHighPriorityFalseNegatives).toBe(1);
    expect(metrics.unguardedHighPriorityFalseNegatives).toBe(1);
    expect(evaluationThresholdFailures(metrics)).toContain(
      "unguarded high-priority false negatives 1 exceeds 0",
    );
  });

  it("fails unsafe actions and missed deterministic review requirements", () => {
    const rows = Array.from({ length: 10 }, () => passingRow());
    rows[0] = passingRow({ unsafeSuggestedAction: true });
    rows[1] = passingRow({ expectedNeedsReview: true, needsReview: false });
    const failures = evaluationThresholdFailures(
      calculateEvaluationMetrics(rows),
    );

    expect(failures).toEqual(
      expect.arrayContaining([
        "unsafe suggested actions 1 exceeds 0",
        "missed required reviews 1 exceeds 0",
      ]),
    );
  });
});
