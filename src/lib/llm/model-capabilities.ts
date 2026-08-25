import type { ProviderName } from "@/lib/domain/taxonomy";

const MAX_MODEL_DISPLAY_LENGTH = 300;
const UNSAFE_MODEL_DISPLAY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

const ANTHROPIC_STRUCTURED_TRIAGE_MODEL =
  /^claude-(?:sonnet-(?:5|4-6)|opus-(?:5|4-[6-8])|fable-5|mythos-(?:5|preview))(?:-\d{8})?$/u;

const OPENAI_STRUCTURED_TRIAGE_MODELS = [
  /^gpt-5(?:\.\d+)?(?:-[a-z0-9]+)*$/u,
  /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/u,
  /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u,
  /^o(?:1|3|4)(?:-[a-z0-9.-]+)*$/u,
] as const;

const BEDROCK_STRUCTURED_TRIAGE_MODEL =
  /^(?:(?:global|us|eu|apac)\.)?anthropic\.claude-(?:sonnet-4-[56]|opus-4-[56]|haiku-4-5)(?:-\d{8})?(?:-v1(?::0)?)?$/u;

export function supportsAnthropicStructuredTriage(model: string): boolean {
  return ANTHROPIC_STRUCTURED_TRIAGE_MODEL.test(model.trim());
}

export function supportsOpenAIStructuredTriage(model: string): boolean {
  const normalized = model.trim();
  return OPENAI_STRUCTURED_TRIAGE_MODELS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function openAIReasoningEffort(model: string): "none" | undefined {
  return /^gpt-5\.6(?:-|$)/u.test(model.trim()) ? "none" : undefined;
}

export function supportsBedrockStructuredTriage(model: string): boolean {
  return BEDROCK_STRUCTURED_TRIAGE_MODEL.test(
    sanitizeModelForDisplay("bedrock", model),
  );
}

export function sanitizeModelForDisplay(
  provider: ProviderName,
  model: string,
): string {
  const normalized = model.normalize("NFKC").trim();
  const withoutBedrockArn =
    provider === "bedrock"
      ? normalized.split("/").at(-1)?.trim() || ""
      : normalized;

  return withoutBedrockArn
    .replace(UNSAFE_MODEL_DISPLAY_CHARACTERS, "�")
    .slice(0, MAX_MODEL_DISPLAY_LENGTH)
    .trim();
}
