# Reports and includes (`PROG/P`, `PROG/I`)

Read after `SKILL.md` when writing an executable program or a program include.

- `abap_write` writes a `PROG/P` whole; there is no `method`-style partial replace. Use
  `dry_run: true` on a rewrite and pass the returned `current_etag` as `expect_etag`.
- `PROG/I` includes are created and deleted like any source object. A `PROG/I` cannot be
  deleted while a program still `INCLUDE`s it; remove the `INCLUDE` line and activate the
  program first.
- `abap_run` executes the report and captures its list output (`WRITE`). Selection-screen
  parameters go in `abap_run`'s `parameters` argument, not into the source.
- `SELECT` and character-test traps that pass the syntax check are in `SKILL.md`.
