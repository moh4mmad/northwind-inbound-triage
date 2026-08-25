# Northwind Inbound Triage

A local-first inbox that uses an LLM to summarize, classify, prioritize, and suggest a human next step for each inbound message. Source messages remain immutable, triage attempts are appended to SQLite, and one malformed message or provider failure cannot stop the rest of the queue.

## Quick start

Requirements: Node.js 22.13+. Credentials are only required to analyze messages; the inbox and provider setup guidance load without them.

```bash
npm install
cp .env.example .env.local
chmod 600 .env.local
# Configure one provider in .env.local.
npm run db:setup
npm run dev
```

Open `http://127.0.0.1:3000`.

| Provider            | Select with              | Required local configuration                                     |
| ------------------- | ------------------------ | ---------------------------------------------------------------- |
| Anthropic (default) | `LLM_PROVIDER=anthropic` | `ANTHROPIC_API_KEY`, supported `ANTHROPIC_MODEL`                 |
| OpenAI              | `LLM_PROVIDER=openai`    | `OPENAI_API_KEY`, supported `OPENAI_MODEL`                       |
| Amazon Bedrock      | `LLM_PROVIDER=bedrock`   | AWS credential chain, `AWS_REGION`, supported `BEDROCK_MODEL_ID` |

Only the selected adapter is created; provider errors never trigger a silent fallback to another provider. **Configured locally** means the selected model and explicit local settings are syntactically valid. Authentication, model access, quota, and Bedrock credential availability are verified only when the first provider request is made.

## Design choices and tradeoffs

- **Next.js:** keeps the React inbox and server-only provider/database boundary in one small project. It is slightly more framework than a client-only React app, but avoids a separate API service and prevents API keys from reaching the browser.
- **SQLite:** fits a local, single-user tool and preserves immutable messages with append-only triage history. It is not suitable for distributed workers or 10,000 messages per day without moving to managed storage and a durable queue.
- **One LLM call per item:** matches the brief and isolates failures by row. Analyze All uses three workers, with a matching server concurrency cap and configurable minute/day admission limits to bound paid work.
- **Structured output with independent validation:** each provider receives a JSON Schema, and the returned value must also pass the shared Zod schema. Malformed output becomes a visible, retryable row failure rather than corrupting the queue.
- **Human review over false confidence:** near-empty, garbled, low-context, suspicious, Unicode-obfuscated, or truncated inputs still go to the LLM for a bounded summary, but deterministic rules force **Needs review**. Suggested actions are advisory only and are never executed.

Provider calls use bounded timeouts, transient-only retries, and safe error messages. The application is intentionally local-only and has no authentication; deployment would require authenticated authorization, TLS, managed secrets, retention controls, and an approved policy for sending advisory messages to model providers. See [`RATIONALE.md`](./RATIONALE.md) for detailed trust boundaries, scaling risks, and implementation references.

## Prompt and evaluation

[`prompts/triage-v2.md`](./prompts/triage-v2.md) is the runtime prompt. It treats every inbound field as untrusted data, defines category and priority precedence, and constrains sensitive suggested actions. Provider-native structured output is followed by Zod validation and a deterministic output policy.

The normal test suite uses mocks and makes no paid provider calls. `npm run eval` is opt-in, makes paid calls to the selected provider, and checks the supplied queue plus adversarial fixtures against checked-in quality and safety thresholds.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Airtable and automation extension

In Airtable, I would use **Inbound Messages** for immutable source fields and a linked **Triage Runs** table for append-only attempts and results. An n8n automation could trigger when a high-priority run succeeds, create an internal review task, and notify the designated advisor. Human approval would remain mandatory before any client-facing or consequential action.

## AI use

I used AI assistance for option comparison, scaffolding, and adversarial review, then reviewed and tested every resulting decision. In one controlled prompt ablation, the model labeled the vague `inb-009` follow-up as `prospect / medium`, inventing a lead and urgency that were not present. I rejected that classification, retained an explicit `unknown` category, and added a deterministic low-context review rule; the final behavior is `unknown / low` with human review. The full engineering reasoning is in [`RATIONALE.md`](./RATIONALE.md).
