export const CATEGORY_KEYS = [
  "prospect",
  "existing_client",
  "partnership",
  "vendor",
  "recruiting",
  "newsletter_spam",
  "unknown",
] as const;

export type Category = (typeof CATEGORY_KEYS)[number];

export const CATEGORY_DEFINITIONS: Record<
  Category,
  { label: string; description: string }
> = {
  prospect: {
    label: "Prospect",
    description:
      "A potential new client asking about advisory or planning services.",
  },
  existing_client: {
    label: "Existing client",
    description: "A request, concern, or service need from a current client.",
  },
  partnership: {
    label: "Partnership",
    description:
      "A referral, strategic alliance, or other mutually beneficial relationship proposal.",
  },
  vendor: {
    label: "Vendor",
    description:
      "A company or salesperson offering software, products, or professional services.",
  },
  recruiting: {
    label: "Recruiting",
    description:
      "A job opportunity, recruiter outreach, or employment-related message.",
  },
  newsletter_spam: {
    label: "Newsletter / spam",
    description:
      "Automated marketing, newsletters, irrelevant bulk mail, or other inbox noise.",
  },
  unknown: {
    label: "Unknown",
    description:
      "There is not enough reliable context to assign another category.",
  },
};

export const PRIORITY_KEYS = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITY_KEYS)[number];

export const PRIORITY_DEFINITIONS: Record<Priority, string> = {
  high: "An explicit short deadline, active-client harm or complaint, security/compliance concern, or immediate financial consequence.",
  medium:
    "Legitimate, actionable relationship work without immediate harm or a short deadline.",
  low: "No-rush inquiries, unsolicited outreach, newsletters, spam, or general noise.",
};

export const RUN_STATUS_KEYS = [
  "processing",
  "succeeded",
  "needs_review",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUS_KEYS)[number];

export const INPUT_QUALITY_KEYS = ["valid", "low_signal", "malformed"] as const;
export type InputQuality = (typeof INPUT_QUALITY_KEYS)[number];

export const PROVIDER_KEYS = ["anthropic", "openai", "bedrock"] as const;
export type ProviderName = (typeof PROVIDER_KEYS)[number];
