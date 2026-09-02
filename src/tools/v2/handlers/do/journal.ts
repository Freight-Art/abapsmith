/**
 * `abap_do`'s journal group: `journal_list`, `journal_show`.
 * Local filesystem reads only — no pool lease, no safety gate (see src/tools/journal.ts).
 * `ctx.object` maps to a different v1 field per action: `object` (name filter) for list,
 * `entry` (entry id) for show — see the git history.
 */
import { abapJournal, JournalInput } from "../../../journal.js";
import type { DoHandler } from "./types.js";
import { doOk, parseV1, withField, withObject } from "./shared.js";

const list: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "object", ctx.object), "mode", "list");
  const input = parseV1(JournalInput, args);

  const res = await abapJournal(deps.pool.primary(), input, deps.cfg.maxResponseChars, deps.journal, deps.safety);
  return doOk(res.text, [
    { tool: "abap_do", args: { action: "journal_show" }, why: "Show one entry's before-image in full." },
  ]);
};

const show: DoHandler = async (ctx, deps) => {
  const args = withField(withObject(ctx.args, "entry", ctx.object), "mode", "show");
  const input = parseV1(JournalInput, args);

  const res = await abapJournal(deps.pool.primary(), input, deps.cfg.maxResponseChars, deps.journal, deps.safety);
  return doOk(res.text, [
    { tool: "abap_do", args: { action: "undo", object: input.entry }, why: "Undo this entry, restoring the before-image." },
  ]);
};

export const JOURNAL_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([
  ["journal_list", list],
  ["journal_show", show],
]);
