# Engineering Rationale

## A. Scope and trust boundary

This is a local, single-user take-home, not a production inbox. Next.js keeps the React UI and Node-only API boundary in one project; provider SDKs, API keys, and SQLite imports remain server-only. Both development and production scripts bind to `127.0.0.1`, and the page plus data routes reject non-local hostnames to limit DNS-rebinding exposure. POST analysis requests also reject a conflicting browser `Origin`, require JSON plus the application's custom header, and stay under a small body limit. CSP, frame denial, restrictive referrer/permissions policies, and `nosniff` harden the browser boundary.

Those controls prevent common accidental or cross-site invocation; none authenticates a person. A network deployment is blocked until authentication and per-message authorization protect both the page and routes. It would also need TLS, centralized secrets, tenant isolation, and an approved policy for sending financial/client messages to a model provider. The default database directory and SQLite artifacts are restricted to owner-only POSIX modes where the filesystem supports them, but production storage needs managed encryption, backups, retention/deletion workflows, and audited access.

Relevant code: `package.json`, `next.config.ts`, `src/lib/http/`, and `src/lib/db/connection.ts`.

## B. Data, taxonomy, and audit history

The seven categories are `prospect`, `existing_client`, `partnership`, `vendor`, `recruiting`, `newsletter_spam`, and `unknown`. Relationship type and urgency are separate: an upset client remains `existing_client`, while `high` carries the urgency. Explicit precedence keeps product sellers in `vendor`, recruiters in `recruiting`, and bulk promotion in `newsletter_spam` even when the sender uses words such as “partner,” “security,” or an artificial deadline. `unknown` is the safe choice when purpose cannot be established from the message.

SQLite stores immutable source messages and append-only run attempts. A processing-run uniqueness constraint prevents two simultaneous analyses of one message. Terminal transitions are validated, persistence-finalization failure is not disguised as a provider error, and stale processing recovery happens at startup and before a new mutation rather than during a dashboard read. Successful runs retain both the sanitized configured model label and the sanitized adapter-resolved model, which uses the provider response when it is available, plus prompt version, attempts, token usage, and timing. This preserves model-alias evidence where the provider returns it without exposing a Bedrock account ARN.

Taxonomy enums stay at the TypeScript/Zod boundary rather than a database `CHECK`, so adding categories does not require rebuilding the table. Relevant code: `src/lib/domain/taxonomy.ts`, `src/lib/db/`, and `db/migrations/003_resolved_model.sql`.

## C. Untrusted input and prompt v2

Every field in the inbound object is evidence, never instruction. Prompt v2 explicitly ignores attempts to change category, priority, schema, system rules, or reviewer action; treats claimed identities and client relationships as unverified; and requires trusted-channel verification before sensitive disclosure or account-related work. JSON serialization escapes `<`, `>`, and `&`, so an inbound `</inbound_message>` string cannot close the application marker.

The prompt projection is deliberately different from the immutable source record:

- text is normalized with NFKC;
- dangerous control, surrogate, bidi, zero-width, and other formatting characters are stripped from the projection and flagged;
- suspicious meta-instructions are flagged;
- long bodies retain both head and tail within an 8,000-character budget and show an omission marker.

Near-empty and garbled inputs are malformed. Low-context, suspicious-instruction, suspicious-Unicode, and truncated inputs are low-signal. Both states deterministically require review even if the model returns a confident category. This closes the earlier false-negative where a dangerous tail could be omitted while the retained head still appeared valid. The model is still called so the reviewer gets a bounded summary, but the status cannot silently become safe.

Suggested actions are text-only and never executed. In addition to prompt constraints, a deterministic post-output policy rejects actions that direct a reviewer to sender-supplied links/addresses, expose credentials, execute transfers/trades, or disclose sensitive records without verification. A rejection becomes a safe failed run rather than advisory text in the inbox.

Relevant code: `src/lib/domain/input-quality.ts`, `src/lib/triage/prompt.ts`, and `src/lib/triage/output-policy.ts`.

## D. Structured output across three providers

Anthropic (default), OpenAI, and Bedrock implement one small `TriageProvider` contract; only the selected provider is instantiated, and failure never triggers a silent cross-provider fallback. Local configuration trims explicit secrets and validates numeric bounds plus a conservative allowlist of model families known to support the adapter's structured-output path. “Configured locally” therefore means the required explicit settings the app can inspect are present and syntactically compatible; it does not verify an ambient AWS credential chain, remote authentication, access, quota, or regional availability.

The application requests provider-native JSON Schema output, then treats the response as `unknown`. A shared Zod schema independently enforces exact keys, enums, bounded non-empty one-line strings, and exclusion of control/format Unicode. Bedrock's structured-output subset does not accept several string constraint keywords, so its adapter moves `minLength`, `maxLength`, and `pattern` into schema descriptions for model guidance; the unchanged Zod boundary remains authoritative. This provider compatibility transform is safer than weakening the application contract or pretending all providers accept identical schema dialects.

Provider-specific behavior stays explicit: Anthropic uses low effort for this small classification, OpenAI only sends a reasoning option for models where the adapter supports it, and Bedrock has a larger attempt timeout for first-use grammar compilation. SDK retries are disabled so one central policy controls attempts and accounting.

Relevant code: `src/lib/llm/anthropic.ts`, `openai.ts`, `bedrock.ts`, `model-capabilities.ts`, `structured-output.ts`, and `src/lib/domain/schemas.ts`.

## E. Failure and cost containment

An individual provider attempt is abortable and bounded. Defaults are 30 seconds for Anthropic/OpenAI and 180 seconds for Bedrock; the all-attempt deadline is 240 seconds, safely below stale-run recovery. The larger Bedrock budget accommodates most first-use schema compilation but still fails safely if AWS's several-minute cold path exceeds the application bound. Attempts default to two and cannot exceed three. Only transient rate-limit, timeout, network, and availability failures retry, with exponential jitter and a bounded provider `Retry-After`; permanent authentication, permission, quota, schema, refusal, and output-policy failures do not. Safe error codes and retryability reach the UI, while provider exception details and message contents do not.

The browser's three-worker Analyze All pool is backed by a process-wide maximum of three active paid operations. Fixed-window admission defaults to 30/minute and 500/day and returns `429`/`503` plus `Retry-After` when full. The server guard matters because callers can bypass UI concurrency. These counters reset with the process and cannot coordinate replicas: production requires a shared rate limiter, durable queue, per-principal quotas, idempotency keys, leases, dead-letter handling, and worker observability.

Relevant code: `src/lib/llm/retry.ts`, `src/lib/llm/errors.ts`, `src/lib/http/triage-admission.ts`, and the triage route.

## F. Browser data minimization and race handling

The browser needs source fields for search and “show original,” but it does not need provider/model identifiers, prompt version, token counts, attempts, or timing. The dashboard maps internal rows to a strict DTO containing only source fields and the latest visible status/result/error. Both list and mutation responses cross runtime schema boundaries, and a mutation response must match the requested message ID before it can update state.

Analyze All excludes active and already queued IDs, row and batch controls cannot launch overlapping work, and request sequencing prevents a slower stale response from overwriting a newer result. The server-side unique processing constraint remains the final duplicate guard.

Relevant code: `src/lib/domain/dashboard.ts`, `src/lib/triage/dashboard-service.ts`, and `src/components/triage-dashboard.tsx`.

## G. Evaluation evidence

Removing `unknown` in a controlled ablation caused the vague `inb-009` follow-up to be labeled `prospect / medium`; the explanation invented a lead and urgency absent from the source. With the final taxonomy it became `unknown / low`, and the low-context rule independently requires review. A live response also produced a 269-character summary against the 240-character application limit, validating the decision to reject rather than silently truncate model output.

The checked-in golden set measures category/priority on the supplied 13 records. Adversarial fixtures add marker injection, a sales pitch framed as a partnership with an artificial deadline, high-risk content only in a truncated tail, invisible Unicode, and a request to send records to a new sender-provided address. The live evaluator checks output validity, category/priority agreement, required-review behavior, unsafe actions, and guarded versus unguarded high-priority misses. It exits nonzero below 90% valid output or 80% category/priority agreement, or for any unsafe action, missed required review, or unguarded high-priority false negative.

`npm run eval` is intentionally opt-in because it makes paid provider calls. The normal `npm test` path exercises metrics, guardrails, adapters, and the service with deterministic fixtures/mocks and never spends provider tokens; the paid evaluator must remain outside CI. Evaluation thresholds are a regression floor for this tiny corpus, not proof of production safety; a real rollout needs representative labeled data, slice metrics, calibration, reviewer feedback, drift monitoring, and conservative launch gates.

Artifacts: `prompts/triage-v2.md`, `prompts/manifest.json`, `evals/golden.json`, `evals/adversarial.json`, `evals/live-observations.md`, and `scripts/evaluate.ts`.

## H. Production priorities

At 10,000 messages/day, local synchronous SQLite, request-duration model calls, and process-local admission are the first architectural limits. I would ingest into a durable queue, run horizontally scalable workers against managed PostgreSQL, use distributed rate/cost controls, and keep the append-only audit model. Human approval remains mandatory before any client-facing or consequential action.

The largest risk is confidently wrong routing or unsafe guidance for sensitive financial/client communications—not merely malformed JSON. Production approval therefore also requires data minimization before model transmission, provider retention/no-training and regional terms, classification/retention policy, encryption and key rotation, least-privilege RBAC, tenant isolation, tamper-evident audit access, deletion/export workflows, incident response, and continuous measurement of high-priority false negatives.
