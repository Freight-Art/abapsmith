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
- A new `PROG/P` is created with Fixed Point Arithmetic **on**
  (`abapsource:fixPointArithmetic="true"`) by default — opt out with
  `fixed_point_arithmetic: false` if the report genuinely needs it off.
- The text pool (text symbols, selection texts) is written with
  `abap_write`'s `text_pool` parameter, not with `source` — see
  `doc/TOOLS/write-and-activate.md`.
- `PROG/PT` is the program's GUI title (`SET TITLEBAR`, Menu Painter/SE41),
  not the text pool. It is not writable or readable here.
