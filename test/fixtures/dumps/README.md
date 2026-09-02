# Dump fixtures — real captured A4H bytes

These are **real ADT response bodies** captured off the wire from the A4H sandbox
appliance on **2026-08-11**, not hand-written samples. They exist so the dumps
feature is tested against what the server actually sends, including the parts
that are easy to get wrong from a spec: the fixed-width dump key, the `%20`
padding runs, SAP's attribute ordering, and the fact that none of the XML bodies
end in a newline.

Each fixture has a `.meta.json` sidecar recording the source capture, the request
method + path, the `Accept` header that produced this exact representation, the
HTTP status, the original byte length, and the redactions applied.

## Redaction

Two classes of value were substituted, and nothing else:

| Class | Replacement | Length |
| --- | --- | --- |
| Appliance hostname | `a4hsandbox` | 10 chars, identical to the real token |
| Public IPv4 in the `/formatted` banner | `198.51.100.163` (RFC 5737 TEST-NET-2) | 14 chars, identical to the real address |

**Every substitution is length-preserving, and this is load-bearing.** The dump
key is a fixed-width 70-character space-padded structure and the `/formatted`
body is a column-aligned ASCII banner; tests assert on those offsets. A
replacement of a different width would silently move every field after it. The
redaction script verifies that each fixture's byte length is unchanged, and the
sidecars record both `byteLength` and `byteLengthAfterRedaction` so the
invariant is checkable rather than merely asserted.

The RFC 1918 address `172.17.0.2` in both `/formatted` fixtures is left as
captured — it is a container-internal address that discloses nothing and is
evidence of how the server reports its own network context. The
`Database version SQLDBC 2.03.144.1551205008` string is a version number, not an
address, and is likewise untouched.

`people.wdf.sap.corp` in `feed-top3-next.xml` is also left as captured. SAP's own
ADT feed hardcodes it as the Atom author URI, so it appears in every SAP system's
output; it describes SAP's infrastructure, not ours.

Aside from those substitutions the bytes are untouched: percent-encoding,
`%20` padding runs, attribute order, XML escaping, and the absent trailing
newline are all exactly as received.

## Fixtures

| File | Status | What it pins down |
| --- | --- | --- |
| `dump-detail-v1.xml` | 200 | Dump detail, `vnd.sap.adt.runtime.dump.v1+xml` — 20 `dump:chapter` elements |
| `dump-formatted.txt` | 200 | The `/formatted` rendering **of the same dump as `dump-detail-v1.xml`** — 1811 lines, kept whole for the offset-alignment test |
| `dump-formatted-alt.txt` | 200 | A second dump's `/formatted` rendering — 622 lines, for size variation only |
| `feed-top3-next.xml` | 200 | `$top=3` feed — 3 entries plus `rel=self` and `rel=next` cursors |
| `feed-empty.xml` | 200 | A well-formed feed with zero entries (not an error, not a 404) |
| `feeds-catalog.xml` | 200 | `/sap/bc/adt/feeds` — declares the dumps feed and its `feed:extendedData` contract |
| `querycheck-valid.xml` | 200 | `$queryCheck=true`, valid query — a 91-byte self-closing `atom:feed` |
| `querycheck-invalid.xml` | 400 | `$queryCheck=true`, unknown attribute — `ExceptionInvalidData` |
| `dump-detail-406-textplain.xml` | 406 | Detail requested as `text/plain` — the resource offers no such variant |
| `dump-detail-404-doubleenc.xml` | 404 | Double-percent-encoded key (`%2520` padding) — the encoding trap |

## Which fixture belongs to which dump

Two different dumps were captured. Getting this wrong is easy and silent, so it
is spelled out here:

| Dump key (host token redacted) | Fixtures |
| --- | --- |
| `20260811123447a4hsandbox_A4H_00…4` | `dump-detail-v1.xml`, `dump-formatted.txt`, `dump-detail-404-doubleenc.xml` |
| `20260811082715a4hsandbox_A4H_00…6` | `dump-formatted-alt.txt`, `dump-detail-406-textplain.xml` |

**`dump-detail-v1.xml` + `dump-formatted.txt` are the matched pair, and only that
pair is valid for offset-alignment assertions.** Verified empirically: for all 20
`dump:chapter` elements in the detail XML,
`formattedBody.split("\n")[line - 1]` is that chapter's own banner line — 20/20.
The chapter offsets run up to `line="1787"`, which only makes sense against an
1811-line body.

`dump-formatted-alt.txt` is a *different* dump's `/formatted` body (622 lines).
The same check against it scores **0/20**, and its last six chapter offsets fall
off the end of the file entirely. It is kept because it is real captured
evidence and useful for size-variation and parser-robustness tests, but any test
that pairs it with `dump-detail-v1.xml` is testing a fiction. An earlier revision
of this directory made exactly that mistake.
