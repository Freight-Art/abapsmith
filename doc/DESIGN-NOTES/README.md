# Design notes

Why some decisions look odd from the outside. Each entry states the rejected
alternative and what decided it, so the reasoning survives even where the
code itself doesn't show it.

| Part | Covers |
|---|---|
| [API surface and data integrity](api-and-data-integrity.md) | Nothing installed on the ABAP system, tool schemas as a budget, fingerprint-based drift detection, unswitchable truncation, read-only FPM, whole-source writes |
| [Safety, sessions, and concurrency](safety-and-concurrency.md) | Tri-state role detection, authorisation as a type, breaker-on-first-401, unprobed sessions, the explicit lock ledger, the read-only debugger, unreachable dangerous endpoints |
| [Why the v2 tool surface was removed](tool-surface-v2.md) | What the six-tool consolidated surface was, the A/B that measured it against v1, why the frozen-surface policy meant its defects were never fixed, and what a future consolidation would have to prove |
