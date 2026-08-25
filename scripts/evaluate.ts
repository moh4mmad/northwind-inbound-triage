import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";
import { z } from "zod";
import {
  calculateEvaluationMetrics,
  EVALUATION_THRESHOLDS,
  evaluationThresholdFailures,
  type EvaluationMetricRow,
} from "../evals/metrics";
import { CATEGORY_KEYS, PRIORITY_KEYS } from "../src/lib/domain/taxonomy";

nextEnv.loadEnvConfig(process.cwd());

const [{ getRuntimeConfig }, domain, quality, llm, outputPolicy, prompt] =
  await Promise.all([
    import("../src/lib/config/env"),
    import("../src/lib/domain/schemas"),
    import("../src/lib/domain/input-quality"),
    import("../src/lib/llm"),
    import("../src/lib/triage/output-policy"),
    import("../src/lib/triage/prompt"),
  ]);

const messages = domain.inboundMessagesSchema.parse(
  JSON.parse(readFileSync(resolve("data/inbound.json"), "utf8")) as unknown,
);
const expectedSchema = z.array(
  z
    .object({
      id: z.string(),
      category: z.enum(CATEGORY_KEYS),
      priority: z.enum(PRIORITY_KEYS),
    })
    .strict(),
);
const expected = expectedSchema.parse(
  JSON.parse(readFileSync(resolve("evals/golden.json"), "utf8")) as unknown,
);
const expectedById = new Map(expected.map((item) => [item.id, item]));
const adversarialSchema = z.array(
  z
    .object({
      suite: z.string().min(1),
      repeatBody: z
        .object({
          text: z.string().min(1).max(1_000),
          count: z.number().int().positive().max(1_000),
        })
        .strict()
        .optional(),
      message: domain.inboundMessageSchema,
      expected: z
        .object({
          category: z.enum(CATEGORY_KEYS),
          priority: z.enum(PRIORITY_KEYS),
          needsReview: z.boolean(),
        })
        .strict(),
    })
    .strict(),
);
const adversarial = adversarialSchema.parse(
  JSON.parse(
    readFileSync(resolve("evals/adversarial.json"), "utf8"),
  ) as unknown,
);

const goldenCases = messages.map((message) => {
  const reference = expectedById.get(message.id);
  if (!reference) {
    throw new Error(`Missing golden reference for ${message.id}`);
  }
  const assessment = quality.assessInputQuality(message);
  return {
    suite: "golden",
    message,
    expected: {
      category: reference.category,
      priority: reference.priority,
      needsReview:
        quality.requiresInputReview(assessment) ||
        reference.category === "unknown",
    },
  };
});
const adversarialCases = adversarial.map((candidate) => ({
  suite: candidate.suite,
  message: domain.inboundMessageSchema.parse({
    ...candidate.message,
    body: candidate.repeatBody
      ? `${candidate.repeatBody.text.repeat(candidate.repeatBody.count)}${candidate.message.body}`
      : candidate.message.body,
  }),
  expected: candidate.expected,
}));
const evaluationCases = [...goldenCases, ...adversarialCases];

const config = getRuntimeConfig();
if (!config.configured) {
  console.error(
    `Cannot run evaluation: ${config.provider} is selected but its credentials/model are not configured.`,
  );
  process.exit(1);
}
const provider = llm.createTriageProvider(config);

interface EvaluationResult extends EvaluationMetricRow {
  id: string;
  suite: string;
  status: "succeeded" | "needs_review" | "unsafe_output" | "failed";
  inputQuality?: string;
  expectedCategory: (typeof CATEGORY_KEYS)[number];
  expectedPriority: (typeof PRIORITY_KEYS)[number];
  expectedNeedsReview: boolean;
  category?: (typeof CATEGORY_KEYS)[number];
  priority?: (typeof PRIORITY_KEYS)[number];
  policyViolations?: readonly string[];
  attempts?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

const results: EvaluationResult[] = [];

console.log(
  `Evaluating ${evaluationCases.length} messages with ${provider.name}/${config.displayModel}...`,
);

for (const candidate of evaluationCases) {
  const { message, expected: reference, suite } = candidate;
  const assessment = quality.assessInputQuality(message);
  const startedAt = Date.now();

  try {
    const response = await llm.analyzeWithRetry(
      provider,
      {
        systemPrompt: prompt.TRIAGE_SYSTEM_PROMPT,
        userPrompt: prompt.buildTriageUserPrompt(assessment.promptMessage),
        schema: domain.triageWireJsonSchema as unknown as Record<
          string,
          unknown
        >,
        schemaName: "inbound_triage",
      },
      {
        maxAttempts: config.maxAttempts,
        timeoutMs: config.timeoutMs,
        overallTimeoutMs: config.overallTimeoutMs,
      },
    );
    const parsed = domain.triageResultSchema.parse(response.value.output);
    const policyAssessment = outputPolicy.assessTriageOutputPolicy(
      parsed,
      message,
    );
    const needsReview =
      quality.requiresInputReview(assessment) || parsed.category === "unknown";
    const outputValid = policyAssessment.safe;
    const row: EvaluationResult = {
      id: message.id,
      suite,
      category: parsed.category,
      expectedCategory: reference.category,
      categoryMatch: parsed.category === reference.category,
      priority: parsed.priority,
      expectedPriority: reference.priority,
      priorityMatch: parsed.priority === reference.priority,
      status: outputValid
        ? needsReview
          ? "needs_review"
          : "succeeded"
        : "unsafe_output",
      inputQuality: assessment.quality,
      expectedNeedsReview: reference.needsReview,
      needsReview,
      outputValid,
      unsafeSuggestedAction: !policyAssessment.safe,
      policyViolations: policyAssessment.violations,
      attempts: response.attempts,
      inputTokens: response.value.usage.inputTokens,
      outputTokens: response.value.usage.outputTokens,
      durationMs: Date.now() - startedAt,
    };
    results.push(row);
    console.log(
      `${row.categoryMatch && row.priorityMatch && row.outputValid ? "✓" : "△"} ${message.id} [${suite}]: ${parsed.category}/${parsed.priority}${row.outputValid ? "" : " (unsafe action rejected)"}`,
    );
  } catch (error) {
    const safe = llm.toSafeError(error);
    results.push({
      id: message.id,
      suite,
      status: "failed",
      expectedCategory: reference.category,
      expectedPriority: reference.priority,
      expectedNeedsReview: reference.needsReview,
      needsReview: true,
      outputValid: false,
      unsafeSuggestedAction: false,
      errorCode: safe.code,
      errorMessage: safe.message,
      durationMs: Date.now() - startedAt,
    });
    console.log(`✗ ${message.id} [${suite}]: ${safe.code}`);
  }
}

const metrics = calculateEvaluationMetrics(results);
const thresholdFailures = evaluationThresholdFailures(metrics);
const report = {
  generatedAt: new Date().toISOString(),
  provider: provider.name,
  model: config.displayModel,
  promptVersion: prompt.PROMPT_VERSION,
  thresholds: EVALUATION_THRESHOLDS,
  passed: thresholdFailures.length === 0,
  thresholdFailures,
  metrics,
  results,
};

console.log("\nSummary");
console.log(JSON.stringify(metrics, null, 2));
if (thresholdFailures.length > 0) {
  console.error("\nEvaluation thresholds failed:");
  for (const failure of thresholdFailures) console.error(`- ${failure}`);
}

const outputFlagIndex = process.argv.indexOf("--output");
const outputPath =
  outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : undefined;
if (outputFlagIndex >= 0 && !outputPath) {
  throw new Error("--output requires a file path");
}
if (outputPath) {
  writeFileSync(
    resolve(outputPath),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(`Saved evaluation report to ${outputPath}`);
}

if (thresholdFailures.length > 0) process.exitCode = 1;
