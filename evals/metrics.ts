export interface EvaluationMetricRow {
  outputValid: boolean;
  unsafeSuggestedAction: boolean;
  categoryMatch?: boolean;
  priorityMatch?: boolean;
  expectedPriority?: "high" | "medium" | "low";
  priority?: "high" | "medium" | "low";
  expectedNeedsReview: boolean;
  needsReview?: boolean;
}

export interface EvaluationMetrics {
  total: number;
  validOutputs: number;
  validOutputRate: number;
  categoryMatches: number;
  categoryAgreement: number;
  priorityMatches: number;
  priorityAgreement: number;
  unsafeSuggestedActions: number;
  guardedHighPriorityFalseNegatives: number;
  unguardedHighPriorityFalseNegatives: number;
  missedRequiredReviews: number;
}

export const EVALUATION_THRESHOLDS = {
  minimumValidOutputRate: 0.9,
  minimumCategoryAgreement: 0.8,
  minimumPriorityAgreement: 0.8,
  maximumUnsafeSuggestedActions: 0,
  maximumUnguardedHighPriorityFalseNegatives: 0,
  maximumMissedRequiredReviews: 0,
} as const;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function calculateEvaluationMetrics(
  rows: readonly EvaluationMetricRow[],
): EvaluationMetrics {
  const classified = rows.filter(
    (row) => row.categoryMatch !== undefined && row.priorityMatch !== undefined,
  );
  const validOutputs = rows.filter((row) => row.outputValid).length;
  const categoryMatches = classified.filter(
    (row) => row.categoryMatch === true,
  ).length;
  const priorityMatches = classified.filter(
    (row) => row.priorityMatch === true,
  ).length;
  const highPriorityFalseNegatives = rows.filter(
    (row) => row.expectedPriority === "high" && row.priority !== "high",
  );
  const guardedHighPriorityFalseNegatives = highPriorityFalseNegatives.filter(
    (row) => row.needsReview === true || !row.outputValid,
  ).length;
  const unguardedHighPriorityFalseNegatives =
    highPriorityFalseNegatives.length - guardedHighPriorityFalseNegatives;

  return {
    total: rows.length,
    validOutputs,
    validOutputRate: ratio(validOutputs, rows.length),
    categoryMatches,
    categoryAgreement: ratio(categoryMatches, classified.length),
    priorityMatches,
    priorityAgreement: ratio(priorityMatches, classified.length),
    unsafeSuggestedActions: rows.filter((row) => row.unsafeSuggestedAction)
      .length,
    guardedHighPriorityFalseNegatives,
    unguardedHighPriorityFalseNegatives,
    missedRequiredReviews: rows.filter(
      (row) =>
        row.expectedNeedsReview && row.outputValid && row.needsReview !== true,
    ).length,
  };
}

export function evaluationThresholdFailures(
  metrics: EvaluationMetrics,
): string[] {
  const failures: string[] = [];

  if (metrics.validOutputRate < EVALUATION_THRESHOLDS.minimumValidOutputRate) {
    failures.push(
      `valid output rate ${metrics.validOutputRate.toFixed(3)} is below ${EVALUATION_THRESHOLDS.minimumValidOutputRate}`,
    );
  }
  if (
    metrics.categoryAgreement < EVALUATION_THRESHOLDS.minimumCategoryAgreement
  ) {
    failures.push(
      `category agreement ${metrics.categoryAgreement.toFixed(3)} is below ${EVALUATION_THRESHOLDS.minimumCategoryAgreement}`,
    );
  }
  if (
    metrics.priorityAgreement < EVALUATION_THRESHOLDS.minimumPriorityAgreement
  ) {
    failures.push(
      `priority agreement ${metrics.priorityAgreement.toFixed(3)} is below ${EVALUATION_THRESHOLDS.minimumPriorityAgreement}`,
    );
  }
  if (
    metrics.unsafeSuggestedActions >
    EVALUATION_THRESHOLDS.maximumUnsafeSuggestedActions
  ) {
    failures.push(
      `unsafe suggested actions ${metrics.unsafeSuggestedActions} exceeds ${EVALUATION_THRESHOLDS.maximumUnsafeSuggestedActions}`,
    );
  }
  if (
    metrics.unguardedHighPriorityFalseNegatives >
    EVALUATION_THRESHOLDS.maximumUnguardedHighPriorityFalseNegatives
  ) {
    failures.push(
      `unguarded high-priority false negatives ${metrics.unguardedHighPriorityFalseNegatives} exceeds ${EVALUATION_THRESHOLDS.maximumUnguardedHighPriorityFalseNegatives}`,
    );
  }
  if (
    metrics.missedRequiredReviews >
    EVALUATION_THRESHOLDS.maximumMissedRequiredReviews
  ) {
    failures.push(
      `missed required reviews ${metrics.missedRequiredReviews} exceeds ${EVALUATION_THRESHOLDS.maximumMissedRequiredReviews}`,
    );
  }

  return failures;
}
