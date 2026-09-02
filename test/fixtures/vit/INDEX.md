# VIT-bridge existence-probe fixtures

Two of these five files are **LIVE CAPTURES**; the other three are
**RECONSTRUCTIONS** whose envelope is now a known fact.

- **`002` and `003` are byte-verbatim wire captures**, taken 2026-08-30
  against the VIT bridge
  (`/sap/bc/adt/vit/wb/object_type/{type}/object_name/{name}`), HTTP 200:
  `002` in 0.345 s, `003` in 0.176 s. They carry NO trailing newline — the
  file content is exactly the bytes the bridge returned, not a
  text-file-conventions rendering of them.
- **`001`, `004` and `005` are still reconstructions** — the live run
  captured no `TRAN/T` stub at all, so nothing exists to capture for them.
  Their envelope (root `<adtcore:mainObject>`, the `adtcore:version` /
  `adtcore:language` attributes, the single `adtcore:` namespace — there is
  no `vit:` namespace on the wire) is no longer a guess: it is copied from
  the two live captures. Their CONTENT — the object names, and for `005`
  the `packageRef` — is still inferred. Each still carries a trailing
  end-of-file newline that the wire bytes do not, since normal file
  conventions apply to a reconstruction; the declaration-to-element line is
  otherwise contiguous, matching the captures exactly.

**Caveat on `005`:** it renders `packageRef` as a CHILD ELEMENT inside a
non-self-closing root. Both live captures are self-closing with no
children, so the *registered* shape (object exists AND carries a
`packageRef`) has never actually been captured — this is unverified. If it
is wrong, `vitStubShowsRegistration` would read genuinely registered
objects as unregistered. That failure mode fails CLOSED: it over-refuses a
delete rather than permitting deletion of a registered object under a
false unregistered reading, which is why it is acceptable to merge with
the assumption recorded here rather than left implicit.

**The measured byte sizes below are provenance only and deliberately NOT
reproduced as a threshold.** The fix these fixtures pin is a semantic
predicate over named attributes (`vitStubShowsExistence` /
`vitStubShowsRegistration` in `src/adt/write-verify.ts`), not a byte-count
threshold — a byte-count heuristic was explicitly considered and rejected.
Padding these files to hit a target size would misrepresent them as more
precise than they are and would misdirect anyone reading the predicate
against them.

## Table

| # | file | live probe | bytes | attribute inventory |
|---|---|---|---:|---|
| 1 | `001-trant-thin-never-created.xml` | `trant/ZTMD_T442R_NEVER` — never created (reconstructed) | inferred, not measured | `adtcore:name`, `adtcore:type`, `adtcore:version`, `adtcore:language` (thin stub) |
| 2 | `002-viewdv-thin-never-created.xml` | `viewdv/ZTMD_V_NEVERXX` — never created (LIVE CAPTURE) | 203 | thin stub |
| 3 | `003-viewdv-enriched-unregistered.xml` | `viewdv/ZTMD_V_442G2` — EXISTS, TADIR-unregistered (LIVE CAPTURE) | 326 | `adtcore:changedAt`, `adtcore:changedBy`, `adtcore:description`; **no `packageRef`** |
| 4 | `004-trant-thin-after-delete.xml` | `trant/ZTMD_T442R` — after delete (reconstructed) | inferred, not measured | thin stub |
| 5 | `005-trant-enriched-registered.xml` | `trant/SE93` — EXISTS, registered (reconstructed, unverified — see caveat above) | inferred, not measured | `adtcore:packageRef adtcore:name="SEUA"` |

All five probes answered HTTP 200 — that is the finding itself: the
VIT bridge never 404s, so the thin-vs-enriched distinction (not the HTTP
status) is what has to carry the existence question, and `packageRef`
alone answers a narrower question (TADIR registration) that
existence does not depend on. Row 3 is the proof: an object that
demonstrably exists while carrying no `packageRef` at all.

No hostname, IP address, SID, transport ID or password appears in this
directory or in any file it describes.
