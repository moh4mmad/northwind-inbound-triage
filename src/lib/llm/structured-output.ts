import type { ProviderName } from "@/lib/domain/taxonomy";
import { providerError } from "./errors";

const BEDROCK_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "pattern",
]);

export function parseStructuredOutput(
  text: string,
  provider: ProviderName,
): unknown {
  if (text.trim().length === 0) {
    throw providerError("invalid_output", provider);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw providerError("invalid_output", provider, { cause: error });
  }
}

export function transformBedrockStructuredOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return transformBedrockSchemaNode(schema) as Record<string, unknown>;
}

function transformBedrockSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(transformBedrockSchemaNode);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const transformed: Record<string, unknown> = {};
  const applicationConstraints: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(source)) {
    if (BEDROCK_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      applicationConstraints[key] = child;
    } else {
      transformed[key] = transformBedrockSchemaNode(child);
    }
  }

  if (Object.keys(applicationConstraints).length > 0) {
    const existingDescription =
      typeof transformed.description === "string"
        ? transformed.description.trim()
        : "";
    const constraintDescription = `Application-enforced constraints: ${JSON.stringify(applicationConstraints)}`;
    transformed.description = existingDescription
      ? `${existingDescription}\n\n${constraintDescription}`
      : constraintDescription;
  }

  return transformed;
}
