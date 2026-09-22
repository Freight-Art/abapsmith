/**
 * Journals a text pool write (issue #182): `writeTextPool` (src/adt/text-pool.ts)
 * PUTs straight to the textelements resource with no before-image capture, so the
 * entry is recorded `irreversible` — `abap_journal mode=undo` cannot replay it.
 */
import type { AbapConnection } from "../adt/connection.js";
import { textPoolUri, writeTextPool, type TextPoolInput, type TextPoolWriteResult } from "../adt/text-pool.js";
import type { ResolvedTarget } from "../adt/write.js";
import { journalRef, systemKey, withJournalledMutation, type Journal } from "../journal.js";
import type { AuthorizedTarget, MutatingOperation } from "../safety.js";

export const TEXT_POOL_JOURNAL_NOTE =
  "The text pool write is journalled as an irreversible update entry on the PROG/PX textelements resource (history only): abap_journal mode=undo cannot restore the previous texts.";

export async function writeTextPoolJournalled(
  conn: AbapConnection,
  journal: Journal | undefined,
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  pool: TextPoolInput,
  opts: { activate: boolean; corrNr?: string },
): Promise<TextPoolWriteResult> {
  const { result, settle } = await withJournalledMutation<undefined, TextPoolWriteResult>(
    journal,
    {
      begin: () => ({
        operation: "update",
        object: journalRef({
          name: authorized.target.name,
          type: "PROG/PX",
          uri: textPoolUri(authorized.target.name),
          packageName: authorized.target.packageName,
          description: `text pool of ${authorized.target.name}`,
        }),
        existedBefore: true,
        beforeCapture: "unknown",
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        irreversible: true,
        ...(opts.corrNr ? { corrNr: opts.corrNr } : {}),
      }),
    },
    async (onBeforeImage) => {
      await onBeforeImage(undefined);
      return await writeTextPool(conn, authorized, pool, opts);
    },
  );
  await settle({
    outcome: "succeeded",
    activation: result.activation ? { attempted: true, activated: result.activation.activated } : { attempted: false },
  });
  return result;
}
