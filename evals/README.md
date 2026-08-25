# Evaluation

`golden.json` is a small human-reviewed reference for category and priority. `adversarial.json` adds closing-marker injection, vendor/deadline/security-marketing precedence, truncation, invisible-Unicode, and untrusted-destination cases. Neither file asserts exact summaries or actions, which can be phrased many valid ways; generated actions are instead checked against deterministic safety properties.

`npm run eval` is opt-in because it makes real paid calls to the selected provider. It processes the supplied and adversarial messages, reports category/priority agreement, deterministic review behavior, high-priority false negatives, and unsafe-action rejections, and writes no result unless an explicit output path is supplied. It exits unsuccessfully when the checked-in thresholds are missed. Deterministic CI uses mocked adapters and pure metric tests instead.

`live-observations.md` records the bounded manual checks that informed the `unknown` guardrail and local output limits.
