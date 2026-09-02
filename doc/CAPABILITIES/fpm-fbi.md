## FPM and FBI

FBI is not a separate framework in this codebase — the code treats it as FPM
throughout, reading the same configuration table, and distinguishes the two
only by a substring-presence hint.

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Application configuration | no | partial | no | no | n/a | unverified | Decoding is described in source as weakly inferred and not independently verified. |
| Component configuration | no | yes | no | no | n/a | tests | Read through a generated bridge class that only ever issues SELECTs. |
| Feeder / FBI configuration | no | yes | no | no | n/a | tests | Same read path; the FBI distinction is a hint, not a separate model. |
| Enqueue locks on configurations | n/a | yes | n/a | n/a | n/a | live | The one live-tested corner, and the live test is skipped unless a live system is configured. |
| Any write | no | n/a | no | no | n/a | n/a | No write tool exists. |

There is exactly one FPM tool, `abap_fpm_read`, flagged read-only, with modes
`find`, `outline`, `app` and `locks`. The generated bridge never writes a
configuration row. A force-clear code path exists in the source but is
deliberately not wired to any tool, and a test greps the tool directory at
run time to keep it that way; a locked-operation builder exists and is
live-tested but is likewise unreachable from the tool surface. Unreachable
code is not a capability.
