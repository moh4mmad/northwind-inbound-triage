# Live evaluation observations

These are bounded qualitative checks from August 25, 2026, using the installed Claude Sonnet 4.6 CLI because no direct provider SDK key was available. The production configuration still defaults to the current Sonnet model.

- With the final taxonomy and prompt, `inb-009` returned the human category/priority label `unknown / low`. Its summary was 269 characters, beyond the application's 240-character limit, so the same payload would be rejected by local Zod validation.
- In a controlled prompt ablation that removed the `unknown` category, the same record returned `prospect / medium`. The explanation inferred an early-stage lead and urgency to avoid losing it, neither of which the source supports. This is the concrete reason the final taxonomy includes `unknown`, the prompt prohibits invented context, and low-signal input deterministically requires human review.

The reference labels are in `golden.json`. `npm run eval` runs the final application prompt against all fixtures when selected-provider credentials are available.
