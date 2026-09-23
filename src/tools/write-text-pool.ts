/**
 * Journals a text pool write (issue #182, extended #199): `writeTextPool`
 * (src/adt/text-pool.ts) PUTs straight to the textelements resource with no
 * before-image capture, so the entry is recorded `irreversible` —
 * `abap_journal mode=undo` cannot replay it.
 */
import {
  assertTextPoolType,
  textPoolResourceType,
  textPoolUri,
  writeTextPool,
  type TextPoolHeadings,
  type TextPoolInput,
  type TextPoolWriteResult,
} from "../adt/text-pool.js";
import type { AbapConnection } from "../adt/connection.js";
import type { ResolvedTarget } from "../adt/write.js";
import { journalRef, systemKey, withJournalledMutation, type Journal } from "../journal.js";
import type { AuthorizedTarget, MutatingOperation } from "../safety.js";

export const TEXT_POOL_JOURNAL_NOTE =
  "The text pool write is journalled as an irreversible update entry on the object's " +
  "textelements resource (PROG/PX, CLAS/OCX or FUGR/PX; history only): abap_journal mode=undo " +
  "cannot restore the previous texts.";

export function toTextPoolInput(tp: {
  symbols?: Record<string, string>;
  selection_texts?: Record<string, string>;
  headings?: { list_header?: string; column_headers?: string[] };
}): TextPoolInput {
  const headings: TextPoolHeadings | undefined = tp.headings
    ? {
        ...(tp.headings.list_header !== undefined ? { listHeader: tp.headings.list_header } : {}),
        ...(tp.headings.column_headers !== undefined ? { columnHeaders: tp.headings.column_headers } : {}),
      }
    : undefined;
  return {
    ...(tp.symbols !== undefined ? { symbols: tp.symbols } : {}),
    ...(tp.selection_texts !== undefined ? { selectionTexts: tp.selection_texts } : {}),
    ...(headings !== undefined ? { headings } : {}),
  };
}

export async function writeTextPoolJournalled(
  conn: AbapConnection,
  journal: Journal | undefined,
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  pool: TextPoolInput,
  opts: { activate: boolean; corrNr?: string },
): Promise<TextPoolWriteResult> {
  const type = authorized.target.type;
  assertTextPoolType(type, { type, name: authorized.target.name });
  const { result, settle } = await withJournalledMutation<undefined, TextPoolWriteResult>(
    journal,
    {
      begin: () => ({
        operation: "update",
        object: journalRef({
          name: authorized.target.name,
          type: textPoolResourceType(type),
          uri: textPoolUri(authorized.target.name, type),
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
