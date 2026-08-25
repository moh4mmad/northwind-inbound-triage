# Prompt approach

`triage-v2.md` contains the exact system prompt used by the application. It defines a small taxonomy, separates category from urgency, treats inbound content as untrusted data, adds category precedence, and constrains sensitive suggested actions. `triage-v1.md` is retained as immutable history.

Each provider receives the same bounded JSON Schema. The shared Zod boundary then rejects extra keys, invalid enums, empty fields, multiline or dangerous Unicode output, refusals, and truncated or malformed output. A separate output policy rejects suggested actions that would use sender-provided destinations, disclose credentials or sensitive records without verification, or execute financial transactions.

`manifest.json` pins the SHA-256 digest of every retained runtime prompt. The prompt test fails if an existing artifact changes or if runtime instructions do not match the artifact for `PROMPT_VERSION`; a semantic change should add a new version rather than rewriting history.
