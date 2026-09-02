# ADT version-feed fixtures

**Live-captured from A4H (SAP_BASIS 754 SP0007 / S4FND 104) on 2026-08-18**, via a
raw `GET` with `Accept: application/atom+xml;type=feed`. The response bodies are
**byte-for-byte as received** — single line, no whitespace between tags. Nothing
in them was edited, reformatted or scrubbed, and nothing in them may be: they are
the evidence the selection rules in `src/adt/revisions.ts` were derived from, and
a "tidied" capture is no longer a capture.

Every URL inside is server-relative (`/sap/bc/adt/…`). No host, user, password or
client appears in any of them. The `atom:author` values (`SAP`, `SAPUSER`,
`DEVELOPER`) are the shipped SAP appliance account names recorded in the feed as
the author of each version; they are not credentials.

If you add a hand-written feed here, say **SYNTHETIC** in a header comment inside
the file itself. None of the four files below is synthetic.

| file | source | what it proves |
| --- | --- | --- |
| `versions-feed-clas-main-a4h-754.xml` | `GET /sap/bc/adt/oo/classes/cl_ci_inspection/includes/main/versions` | 68 entries; the ACTIVE pseudo-version `00000` repeated ~60 times, mostly with **no `atom:updated` at all**; real history `00063`–`00067`; entries `00001`/`00002`/`00003` carrying an **empty `<atom:author/>`**. This is the C-1 regression fixture — a small feed does not catch what it catches. |
| `versions-feed-clas-testclasses-a4h-754.xml` | `GET /sap/bc/adt/oo/classes/cl_ci_inspection/includes/testclasses/versions` | 5 entries, document order `00000, 00004, 00003, 00002, 00001`. Covers every entry shape in one compact file: a named author, an empty `<atom:author/>`, a transport link **pair** with and without `title`, an entry with **no link at all**, and an entry with **no `updated`**. |
| `versions-feed-clas-testclasses2-a4h-754.xml` | `GET /sap/bc/adt/oo/classes/cl_ci_test_s4h_dd_enhancements/includes/testclasses/versions` | The same shapes on a second, independent object — so a rule is not fitted to one feed. |
| `versions-feed-ztmp-local-class-a4h-754.xml` | `GET /sap/bc/adt/oo/classes/zcl_verhist_probe01/includes/main/versions` | A `$TMP` class created, then edited and re-activated **three** times (all three activations succeeded, distinct source each round). The feed has **exactly one** entry: `00000`. Local objects accumulate **no** version history. The class was deleted after capture. |

## Facts these captures establish

- **`atom:id` is the version number; `atom:title` is not.** `atom:title` is the
  *transport description in free prose* (`"sum required notes"`, `"Apply Notes for
  ATC and S/4HANA Readiness Checks"`) and is absent whenever the transport has no
  description or the entry was never transported. Do **not** read `atom:id`
  through `fullParse` either — `parseAttributeValue: true` turns `00000` into the
  number `0`. The version id is taken from the **second-to-last segment of
  `atom:content/@src`**, which is a plain path string and survives intact.
- **The `content/@src` shape** is
  `/sap/bc/adt/{objectpath}/versions/{feedTimestamp}/{versionId}/content`. The
  timestamp segment is **feed-level and byte-identical on every entry**
  (`20180205111235` on all 68 of the main feed) — it is not a per-version date.
- **`00000` is ACTIVE and `99999` is INACTIVE** (SAP's shipped `Revision.class`
  names them `ACTIVE_BACKEND_VERSION` / `INACTIVE_BACKEND_VERSION`). ACTIVE is a
  *pseudo*-version whose content is the object's current source, not a snapshot,
  and it can appear dozens of times in one feed.
- **Untransported entries carry no `atom:link` at all**, so `abap-adt-api`'s
  documented "fall back to the first link" branch can never fire on this data.
  Transport links always arrive in **pairs**, both
  `rel="http://www.sap.com/adt/relations/transport/request"`, same
  `adtcore:name`, differing only in `type`.
