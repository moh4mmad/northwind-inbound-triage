# Engineering Rationale

## A. Data and taxonomy

I use seven categories: `prospect`, `existing_client`, `partnership`, `vendor`, `recruiting`, `newsletter_spam`, and `unknown`. They reflect the distinct routing decisions in this inbox: prospective and existing clients need different owners, while partnerships, vendors, recruiting messages, and bulk mail follow separate workflows. Category and urgency are deliberately independent—a time-sensitive client request can be `existing_client / high`, while an exploratory prospect can be `prospect / low`. `unknown` is an intentional safe outcome when the message does not contain enough evidence to route confidently.

SQLite stores each source message separately from its append-only analysis attempts, so reruns preserve history without changing the inbound data. Categories are validated at the TypeScript/Zod boundary instead of with a database `CHECK`; doubling the taxonomy means extending the enum, prompt, tests, and routing rules rather than rebuilding stored tables. In production, I would version the taxonomy so historical results retain their original meaning.

Relevant code: `src/lib/domain/taxonomy.ts`, `src/lib/domain/schemas.ts`, and `src/lib/db/`.

## B. Reliable structured output

Anthropic is the default provider, with OpenAI and Bedrock behind the same small `TriageProvider` interface. The selected adapter requests provider-native JSON Schema output, but its response is still treated as untrusted `unknown` data. A shared strict Zod schema requires exactly the expected keys, valid category and priority enums, and bounded one-line text. There is no silent provider fallback, so a failure cannot unexpectedly send the message to another vendor.

Malformed JSON or a schema-invalid result fails safely rather than being guessed, coerced, or silently truncated. Only transient failures such as rate limits, timeouts, and temporary provider errors are retried. The UI records the failure and continues the queue; failed or cancelled items can be run again, while Analyze All skips successful items.

The prompt treats inbound fields as evidence rather than instructions. After schema validation, a deterministic policy rejects suggested actions involving sender-supplied destinations, unverified disclosure, credentials, or consequential financial actions. Suggested actions are displayed only; they are never executed.

Relevant code: `src/lib/triage/prompt.ts`, `src/lib/domain/schemas.ts`, `src/lib/triage/output-policy.ts`, `src/lib/llm/`, and `src/lib/llm/retry.ts`.

## C. Where the model was wrong

The clearest error appeared during a controlled taxonomy test with `inb-009`, a vague message that only says the sender is following up and asks for the next step. When I removed `unknown` as an allowed category, the model labeled it `prospect / medium`. That invented both a prospective-client relationship and urgency that were not present in the source. Restoring `unknown` produced `unknown / low`, and the independent low-context rule marks it for human review instead of allowing a confident automatic route.

I also observed a live response with a 269-character summary even though the application limit is 240 characters. I chose to reject the result rather than silently trim it because truncation can change meaning and would hide a contract failure. These cases shaped both the taxonomy and the decision to validate model output independently of the provider's structured-output feature.

Evidence: `evals/live-observations.md`, `evals/golden.json`, and `scripts/evaluate.ts`.

## D. Edge cases

I treat effectively empty or unreadable content as malformed. Messages with insufficient routing context, suspicious instructions or Unicode, or truncated bodies are low-signal. Sentinel values such as `(individual)` and `(unknown)` are missing organization data, not company names.

The model still receives a bounded, normalized projection, but deterministic rules force these results into `Needs review`; model confidence cannot override that decision. Long bodies retain their beginning and end within an 8,000-character budget, and unsafe control or formatting characters are removed from the prompt projection and flagged. The immutable source remains available for human inspection.

Relevant code: `src/lib/domain/input-quality.ts`, `src/lib/triage/prompt.ts`, and `src/lib/triage/triage-service.ts`.

## E. Scale and risk

At 10,000 messages per day, request-duration LLM calls, SQLite, browser-driven batching, and process-local limits would be the first constraints. I would use a durable queue, scalable workers, managed PostgreSQL, distributed rate and cost controls, idempotency, dead-letter handling, and operational metrics. The current three-worker UI queue and server admission control suit this local exercise, but they are not a distributed job system.

The largest business risk is a plausible but wrong result—especially a high-priority false negative—or an unsafe recommendation involving sensitive client information. I would require human approval for client-facing or consequential actions, minimize data sent to the provider, and enforce approved retention and processing terms. Production also needs access control, encryption, tenant isolation, audit and deletion workflows, representative labeled evaluations, and reviewer feedback. I would measure high-priority recall and widen automation only when the evidence supports it.

Relevant code and artifacts: `src/lib/http/triage-admission.ts`, `src/components/triage-dashboard.tsx`, `evals/`, and `scripts/evaluate.ts`.
