# Execute & test

Running and unit-testing ABAP objects. For static analysis, see
[abap_atc](abap-atc.md).

## abap_run

Execute a class (via `IF_OO_ADT_CLASSRUN`) or a report, headlessly, and
capture its output.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes | — | Class or report to run. |
| `mode` | enum `class` \| `report` \| `auto` | no | `auto` | Force one execution style or let the server infer it. |
| `parameters` | array\<object\> | no | — | Report mode only — selection-screen parameters. |

Each `parameters[]` entry: `name` (string, required), `type` (enum `char` \|
`int` \| `packed` \| `date`, optional), `value` (string, optional),
`ranges` (array of `{sign?, option?, low, high?}`, optional; `sign` is `I`/
`E`, `option` is one of `EQ NE GT LT GE LE CP NP BT NB`).

Notes: uses a real write session but leases a **read** slot from the
connection pool — deliberate, since it doesn't hold an ABAP enqueue lock.
Report mode generates a throwaway bridge class in a dedicated package; it
cannot render interactive lists or ALV grids (headless only). Runs in a
fresh session each time to avoid stale-class caching.

Example:

```json
{
  "object": "ZCL_DEMO_ORDER",
  "mode": "class"
}
```

## abap_test

Run ABAP Unit tests for an object and report pass/fail with messages.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes | — | Object to test. |
| `type` | string | no | — | ADT type hint. |
| `risk_level` | enum `harmless` \| `dangerous` \| `critical` | no | `harmless` | Which risk-level test methods to run, cumulative from harmless up. |

Notes: four outcomes, only one of which is a pass. `PASSED` — tests ran and
all succeeded. `FAILED` — at least one assertion failed. `NO TESTS RAN` —
the object has no test methods at this risk level; **this is not a pass**,
it is the absence of evidence. `UNKNOWN` — the run could not be graded; also
not a pass.

