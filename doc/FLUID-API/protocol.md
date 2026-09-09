# Fluid wire protocol

`IF_OO_ADT_CLASSRUN` has no input channel: ADT lets you execute a class
and read its console, but there is no way to pass parameters in. That
constraint shapes the whole object model — per-call input has to be
baked into a class that gets written just for that call.

So each tool is split in two:

- a **body class**, static, one per tool, named by the manifest's
  `entry`. It exposes `CLASS-METHODS run IMPORTING iv_action TYPE
  string iv_json TYPE string`. It is written once, cached, and its
  source never contains call arguments.
- an **invoker**, `ZCL_ZMCP_I_<hash8>`, generated per call and
  implementing `IF_OO_ADT_CLASSRUN`. Its whole body is the chunked
  argument JSON plus one call into the body class.

`hash8` covers `{tool, action, arguments, contract}`. An identical
repeat call therefore names the same invoker, and the write is skipped
by the existing content compare — invoker population is bounded by
**distinct call shapes, not call count**.

## The framed console dialect

One dialect on the classrun console, one frame per line, every frame
prefixed `ZMCP-H>`.

```
ZMCP-H>BEGIN {"id":"ddic","ver":"a1b2c3d4","action":"create_view","contract":"1.0"}
ZMCP-H>OUT   {"created":true,"name":"ZV_DEMO"}
ZMCP-H>OUTC  {"rows":[{"a":1},{"b":            <- fragment of one value, repeatable
ZMCP-H>OUTE  2}]}                              <- last fragment of that value
ZMCP-H>ERR   {"kind":"subrc","step":"DDIF_VIEW_PUT","subrc":2,"msgid":"E1",
              "msgno":42,"msgv":["ZV_DEMO"],"text":"…"}   (one line in reality)
ZMCP-H>END   {"rc":0,"outBytes":812,"truncated":false,"ms":143}
```

## Frame reference

### `ZMCP-H>BEGIN`

Emitted first, exactly once, before any other frame.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | the tool id |
| `ver` | string | 8-hex-char version of the deployed tool that is actually running |
| `action` | string | the action name |
| `contract` | string | the contract this deployment was written against |

`BEGIN.ver` proves, at zero extra cost, which version actually ran —
the one thing a local cache cannot know on its own. The caller compares
it against the version it expected; a mismatch corrects the registry
rather than failing the call.

### `ZMCP-H>OUT`

Carries one complete JSON value on a single line. If the action's
output schema is an array, each value emitted (via `OUT`, or via one
`OUTC…OUTE` run) is one array element; otherwise exactly one value is
expected across the whole transcript.

### `ZMCP-H>OUTC` / `ZMCP-H>OUTE`

A single JSON value split across multiple console lines because it did
not fit on one. `OUTC` carries a fragment and may repeat any number of
times; `OUTE` carries the last fragment. The fragments are concatenated
in order and parsed exactly once, as one value.

### `ZMCP-H>ERR`

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"subrc"` \| `"exception"` \| `"message"` | what failed |
| `step` | string | the step name, usually the action or the point in it |
| `subrc` | number, optional | the return code, when `kind` is `"subrc"` |
| `msgid` | string, optional | message class |
| `msgno` | number, optional | message number |
| `msgv` | string array, optional | message variables |
| `text` | string | human-readable text |

Any `ERR` frame produces `FLUID_ACTION_FAILED`, with the frame itself
carried as the error's structured details.

### `ZMCP-H>END`

Emitted last, exactly once, closing the transcript.

| Field | Type | Meaning |
|---|---|---|
| `rc` | number | the body class's own return code |
| `outBytes` | number | bytes written to `OUT`/`OUTC`/`OUTE` |
| `truncated` | boolean | whether the ABAP side itself had to stop early |
| `ms` | number | server-side execution time |

## Rules

- Exactly one `BEGIN` first, exactly one `END` last.
- `OUT` carries one complete value; `OUTC…OUTE` carries one value split
  over lines, concatenated and parsed once. An array output schema
  expects one value per element; any other schema expects exactly one
  value.
- Any `ERR` frame produces `FLUID_ACTION_FAILED` with the frame as
  structured details.
- **A missing `END` is a dump or a cut-off run, and is reported as
  such — never as empty success.** The existing ABAP-dump translation
  applies unchanged; a truncated console read is not silently treated
  as a call that returned nothing.
- Console lines that are not frames are kept, not silently discarded —
  a stray `WRITE` from broken operator code is diagnostic evidence, not
  noise. It is reported as a `warnings` entry on the result, whether the
  call succeeds or fails. A value whose `OUTC`/`OUTE` reassembly could
  not be parsed is reported the same way, but only when an `ERR` frame
  already explained the failure — otherwise the reassembly failure
  itself is the error.

### No caps

The framework never truncates its own output. There is no byte
ceiling, no value-count ceiling, and no input ceiling. `truncated`
stays in `END` so ABAP code that genuinely had to stop (a bounded
`SELECT`, say) can say so honestly, but abapsmith's own generated code
never sets it. `FLUID_INPUT_TOO_LARGE` does not exist as an error code.

Oversized responses go through the same generic budget every other
tool already uses: `buildResponse` (`src/compact.ts:206`), bounded by
`ABAP_MAX_RESPONSE_CHARS` (default 47,100 characters). The framework
adds nothing on top of that budget.

### Input chunking is a line-length rule, not a cap

Arguments are serialised to JSON, then chunked into at most 90 raw
characters per ABAP string literal (at most 180 characters after quote
doubling), and reassembled by the invoker before it calls the body
class. ABAP source lines may not exceed 255 characters, so a long
argument turns into more generated lines — never a refusal. Every
generated line is checked against the 255-character limit before the
first network call; a violation is `FLUID_PROTOCOL_ERROR`, naming the
offending line.

### The framework runtime class

`ZCL_ZMCP_FLUID_RT` is deployed once per system and shared by every
tool. It provides `begin` / `out` / `out_chunk` / `err` / `end` plus
JSON helpers — the only way a body class is allowed to produce output;
see [authoring.md](authoring.md).

It installs through the same manifest path as everything else: deploy
order is `ZCL_ZMCP_FLUID_RT` first, then the tool's own `objects` in
array order. There is no dependency solver — the manifest author is
responsible for ordering the array correctly.

Classic (non-class-based) exceptions are caught with `EXCEPTIONS OTHERS
= 1` and reported as `kind: "subrc"`.

### Transaction handling is the framework's job, not the author's

A `mutate` action gets `COMMIT WORK AND WAIT` on success and `ROLLBACK
WORK` on error from the framework wrapper. Author code never issues its
own commit or rollback.

## The call order `dispatch()` follows

Every caller — the `abap_fluid` MCP tool and any dedicated tool that
calls a fluid action internally — goes through the same `dispatch()`
entry point, in this order:

1. Check whether the fluid API is disabled at all: the flag, then
   read-only in any of its senses. Nothing is written.
2. For a plugin tool, the plugin gates: `ABAP_ALLOW_FLUID_PLUGINS`,
   and for a `mutate` action also `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`
   plus the `confirm` echo.
3. Validate the arguments against the action's `input` schema, before
   any network call.
4. Resolve `targets` from the arguments and hand the resulting object,
   package and transport to the safety gate, before any ABAP source is
   generated.
5. Ensure the fluid package exists, then ensure the tool's objects are
   deployed and active.
6. Write the invoker — skipped by the content compare when an
   identical call repeats — activate it, and execute it in a fresh
   session.
7. Parse the console transcript, check `BEGIN.ver` against the
   expected version, and validate the result against the action's
   `output` schema.
8. Journal, where applicable. Framework deploys, relocations and
   `remove` are not journalled — they are generated scaffolding.
   Plugin `mutate` runs are journalled post-hoc, marked irreversible
   unless the manifest names an undo action.

Steps 1, 2 and 4 are safety checks; see [safety.md](safety.md) for the
full ordering and the ordinary ceilings that sit above all of it.
