# Database footprint

`view="footprint"` (`src/adt/footprint.ts`) reports the database writes and
commits a `PROG/P`, `CLAS/OC`, `FUGR/F`, or `FUGR/FF` object's own source
text appears to make. It is static pattern matching over statement text,
not a compiler, not a data-flow analysis, and not a call graph.

- **It cannot see a write reached indirectly.** A write made through a
  dynamically-named subroutine (`PERFORM (lv_form)`), a dynamically-named
  function module (`CALL FUNCTION lv_name`), a generated program, an
  untypeable object reference, or a BAdI implementation is invisible to
  this scanner — none of those call targets are resolved, so nothing on
  the other end is scanned. The reverse also holds: an object with no
  occurrences reported here has not been proven side-effect-free, only
  that its own source contains no recognised write pattern.

- **Database table vs. internal table is a keyword-position heuristic, not
  type information.** `INSERT`/`UPDATE`/`MODIFY`/`DELETE` share syntax
  between database-table and internal-table operations, and the scanner has
  no symbol table — it cannot look up whether `zdemo_soh` in `INSERT
  zdemo_soh FROM gs_soh.` is a DDIC table or a local internal table with
  the same name. It tells the two apart purely by where certain keywords
  sit in the statement, and the following forms are excluded from the
  database-write count on that basis (reported as internal-table
  operations, or not reported at all, rather than a false table hit):
  `INSERT … INTO TABLE`, `INSERT LINES OF`, `INSERT INITIAL LINE`, `MODIFY
  TABLE`, `MODIFY … INDEX`/`… TRANSPORTING`, `DELETE TABLE`, `DELETE
  ADJACENT DUPLICATES`, and `DELETE … INDEX`/`… WHERE` with no `FROM`. An
  internal table whose name happens to match a real DDIC table name (e.g. a
  local `zdemo_soh` work area used with one of the excluded forms) is
  reported by name, exactly as if it were the database table — the scanner
  has no way to know it isn't.

- **`CALL TRANSACTION` and `SUBMIT` are reported because the target MAY
  write, not because a write was observed.** Neither statement is expanded
  into its target's own source; the target name is recorded and the
  occurrence flagged as a possible write, since running an arbitrary
  transaction or report can do anything, including nothing at all.

- **BOPF, `EXEC SQL`, and ADBC detection have no live ground truth.**
  Capture 983 (`Z_I107_FOOTPRINT`, issue #107) exercises every Open SQL
  form, `CALL FUNCTION … IN UPDATE TASK`/`IN BACKGROUND TASK`, `COMMIT
  WORK`/`ROLLBACK WORK`, the named BAPI commit/rollback pair,
  `EXPORT … TO DATABASE`, `CALL TRANSACTION`, and `SUBMIT … AND RETURN` —
  but it contains no `/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY` call, no `EXEC
  SQL`/`ENDEXEC` block, and no `CL_SQL_STATEMENT`/`CL_SQL_CONNECTION` use.
  The patterns that recognise those three forms were written from the
  documented shape of the respective APIs, not from a captured, real
  occurrence of any of them. The fixed notes attached to every rendered
  footprint call this out for BOPF specifically; it applies equally, and is
  recorded here, for `EXEC SQL` and ADBC.

- **A dynamic table name is reported, not resolved.** `UPDATE (lv_tab) …`,
  `DELETE FROM (lv_tab) …`, `INSERT (lv_tab) FROM …`, `INSERT INTO (lv_tab)
  VALUES …`, `MODIFY (lv_tab) FROM …` and `DELETE (lv_tab) FROM …` are listed
  as writes with the parenthesised token as the unresolved target; the token
  may be a variable, a structure component, a field symbol or an attribute. A
  statement is matched after its lines are joined up to the terminating
  period, so a keyword and its target may sit on different lines. Chained
  statements (`UPDATE: …`) are not split at commas and are not recognised.

Evidence: the statement classifier's recognised forms and their exact
matching order are exercised end to end against capture 983's real source
text (`scanFootprint`/`renderFootprint`, offline — `tests` in this
document set's vocabulary, not a live MCP round trip; see
[doc/CAPABILITIES/non-object-capabilities.md](../CAPABILITIES/non-object-capabilities.md)
for the evidence tag on the assembled `abap_read view="footprint"` tool
call itself).
