# Northwind Inbound Triage

A local-first inbox that uses one selected LLM to summarize, classify, prioritize, and suggest a human next step for each inbound message. Source messages remain immutable, every attempt is appended to SQLite, failures stay isolated per row, and uncertain or suspicious inputs are routed to review.

## Quick start

Requirements: Node.js 22.13+. Provider credentials are only needed to analyze messages; the inbox and setup guidance load without them.

```bash
npm install
cp .env.example .env.local
chmod 600 .env.local
# Configure one provider in .env.local.
npm run db:setup
npm run dev
```

Open `http://127.0.0.1:3000`. The `dev` and `start` scripts bind only to `127.0.0.1`.

| Provider            | Select with              | Required local configuration                                     |
| ------------------- | ------------------------ | ---------------------------------------------------------------- |
| Anthropic (default) | `LLM_PROVIDER=anthropic` | `ANTHROPIC_API_KEY`, supported `ANTHROPIC_MODEL`                 |
| OpenAI              | `LLM_PROVIDER=openai`    | `OPENAI_API_KEY`, supported `OPENAI_MODEL`                       |
| Amazon Bedrock      | `LLM_PROVIDER=bedrock`   | AWS credential chain, `AWS_REGION`, supported `BEDROCK_MODEL_ID` |

Only the selected adapter is created, and there is no silent provider fallback. Model IDs are checked against the adapter's supported structured-output families. The UI deliberately says **Configured locally**: this confirms only the explicit local settings the app can inspect and model-ID compatibility, not ambient AWS credential availability, live authentication, model access, quota, or regional availability. Those are verified on the first provider request.

The app attempts POSIX owner-only modes for the default `data/` directory (`0700`) and SQLite database/WAL/SHM files (`0600`). After copying or restoring data, verify them with `ls -la data .env.local`; repair with `chmod 700 data` and `chmod 600 .env.local data/triage.sqlite*`.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Safety and reliability boundaries

- **Local-only, not deployable as-is:** there is intentionally no user authentication or authorization. Loopback binding, a strict localhost/loopback host allowlist, rejection of conflicting browser origins, JSON-only mutations, a required application header, a small request-body limit, and browser security headers reduce accidental exposure; they are not authentication. **Adding authenticated authorization at the page and API boundaries is a deployment blocker**, alongside TLS, secrets management, and an approved data-governance posture.
- **Bounded paid work:** Analyze All and the server admit at most three concurrent analyses. In-process fixed-window limits default to 30 requests/minute and 500/day (`TRIAGE_REQUESTS_PER_MINUTE`, `TRIAGE_REQUESTS_PER_DAY`). A unique processing run blocks simultaneous work on the same message.
- **Bounded provider calls:** provider-specific attempt limits default to 30 seconds for Anthropic/OpenAI and 180 seconds for Bedrock to accommodate first-use schema compilation; an overall retry deadline defaults to 240 seconds. `LLM_MAX_ATTEMPTS` defaults to two and is capped at three. Retries are limited to transient failures, use jitter, honor bounded `Retry-After`, and surface safe retryability to the UI. Bedrock can still exceed this bound when AWS takes several minutes to compile a new schema, in which case the run fails safely and can be retried.
- **Prompt v2 guardrails:** every inbound field is untrusted data; marker-significant characters are escaped before interpolation. NFKC normalization removes and flags dangerous control/format Unicode. Long bodies use an 8,000-character head-and-tail projection with an explicit omission marker. Suspicious instructions, Unicode, and truncation always require human review while the raw stored message remains unchanged.
- **Safe advisory output:** provider-native structured output is followed by independent Zod validation. Bedrock receives a compatibility projection for schema keywords it does not support, while Zod still enforces the full enum, length, one-line, Unicode, and no-extra-field contract. A separate policy rejects suggested actions that use sender-supplied destinations, disclose credentials or sensitive records without verification, or execute financial transactions. The app never sends a reply or performs the suggestion.
- **Audit without browser overexposure:** each run records the configured model and the sanitized adapter-resolved model (the provider response when available). The browser receives source fields needed by the inbox plus a narrow latest-result DTO; provider identifiers, prompt version, tokens, attempts, and timing stay server-side. Mutation responses are runtime-validated before client state changes.

SQLite and the in-process admission controller are appropriate for this single-user take-home. A production service still needs a durable queue, idempotency/leases, managed storage, distributed rate limits and quotas, role-based access, retention/deletion policy, encryption/key management, provider data-processing approval, observability, and incident controls.

## Prompt and evaluation

[`prompts/triage-v2.md`](./prompts/triage-v2.md) is the runtime prompt; `triage-v1.md` remains immutable history and `manifest.json` pins prompt hashes. [`evals/golden.json`](./evals/golden.json) covers the supplied queue, while [`evals/adversarial.json`](./evals/adversarial.json) covers delimiter injection, category precedence, tail-only urgency, invisible Unicode, and sender-provided destinations.

`npm run eval` is opt-in and **makes paid calls** to the selected provider. It exits nonzero below the checked-in valid-output/category/priority thresholds or on any unsafe action, unguarded high-priority false negative, or missed required review. The normal `npm test` suite uses deterministic fixtures/mocks and makes no paid calls; `npm run eval` must remain outside CI.

## Airtable and automation extension

I would map immutable source fields to **Inbound Messages** and append-only results to linked **Triage Runs**. An n8n flow could trigger from a successful high-priority run, create an internal review task, and notify the designated advisor. A human approval step would remain mandatory before client-facing or consequential action.

## AI use

AI assistance accelerated option comparison, scaffolding, and adversarial review. Human judgment set the taxonomy, priority policy, deterministic review rules, safety boundary, provider contract, persistence model, and final acceptance checks. See [`RATIONALE.md`](./RATIONALE.md) for the engineering reasoning and [`docs/loom-outline.md`](./docs/loom-outline.md) for the short demo plan.
