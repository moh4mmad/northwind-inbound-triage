import type { ProviderName } from "@/lib/domain/taxonomy";
import { providerError } from "./errors";

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
