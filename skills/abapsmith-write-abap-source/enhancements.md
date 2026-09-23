# Enhancement implementations (`ENHO/XHH`)

Read after `SKILL.md` when writing into an enhancement implementation. For
choosing the enhancement technique itself, see `abapsmith-enhance-standard-code`.

`abap_write`'s `source` for `ENHO/XHH` must be the **whole**
`ENHANCEMENT <n>. ... ENDENHANCEMENT.` skeleton, not just the statements you
want inside it — a bare statement list is rejected. The **named** form
(`ENHANCEMENT-POINT`/`ENHANCEMENT <n> ZFOO.`) is rejected too; only the
positional `ENHANCEMENT <n>.` header is accepted.

Safest shape: `abap_read` the object first, keep its `ENHANCEMENT <n>.` /
`ENDENHANCEMENT.` header and footer lines byte-for-byte, and edit only what's
between them. A rewrite of an enhancement object can never be undone via
`abap_journal mode=undo`, even with `force: true` (only `create_*` and
`set_impl_active` have an undo), so there is no safety net for a mis-shaped
rewrite the way there is for other object types.
