/**
 * Journals a text pool write (issue #182, extended #199, undo #200):
 * `writeTextPool` (src/adt/text-pool.ts) PUTs straight to the textelements
 * resource, so the entry's before-image is captured separately, by reading
 * the complete previous pool (`readTextPool`) before the PUT and encoding it
 * with `textPoolImage`. `abap_journal mode=undo` restores that image.
 */
import {
  assertTextPoolType,
  readTextPool,
  textPoolImage,
  textPoolResourceType,
  textPoolUri,
  writeTextPool,
  type TextPool,
  type TextPoolHeadings,
  type TextPoolInput,
  type TextPoolWriteResult,
} from "../adt/text-pool.js";
import type { AbapConnection } from "../adt/connection.js";
import type { ResolvedTarget } from "../adt/write.js";
import { journalRef, systemKey, withJournalledMutation, type Journal } from "../journal.js";
import type { AuthorizedTarget, MutatingOperation } from "../safety.js";

export const TEXT_POOL_JOURNAL_NOTE =
  "The text pool write is journalled as an update entry on the object's textelements " +
  "resource (PROG/PX, CLAS/OCX or FUGR/PX), with the complete previous pool captured as the " +
  "before-image: abap_journal mode=undo restores it.";

/** Before-image passed through `onBeforeImage`: the read either succeeded or it didn't. */
interface TextPoolBeforeImage {
  pool: TextPool | undefined;
  readError?: string;
}

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
  const { result, settle } = await withJournalledMutation<TextPoolBeforeImage, TextPoolWriteResult>(
    journal,
    {
      begin: (image) => ({
        operation: "update",
        object: journalRef({
          name: authorized.target.name,
          type: textPoolResourceType(type),
          uri: textPoolUri(authorized.target.name, type),
          packageName: authorized.target.packageName,
          description: `text pool of ${authorized.target.name}`,
        }),
        existedBefore: true,
        systemKey: systemKey(conn.cfg),
        tool: "abap_write",
        ...(opts.corrNr ? { corrNr: opts.corrNr } : {}),
        ...(image.readError !== undefined
          ? {
              beforeCapture: "failed",
              undoBlocker: `The previous text pool could not be read (${image.readError}), so there is nothing to restore.`,
            }
          : {
              beforeKind: "text-pool",
              beforeCapture: "captured",
              beforeSource: textPoolImage(image.pool, type),
            }),
      }),
    },
    async (onBeforeImage) => {
      let poolImage: TextPoolBeforeImage;
      try {
        poolImage = { pool: await readTextPool(conn, authorized.target.name, type) };
      } catch (e) {
        poolImage = { pool: undefined, readError: (e as Error).message ?? String(e) };
      }
      await onBeforeImage(poolImage);
      // Write proceeds regardless of the before-read's outcome, as before.
      return await writeTextPool(conn, authorized, pool, opts);
    },
  );
  let afterSource: string | undefined;
  try {
    const after = await readTextPool(conn, authorized.target.name, type);
    afterSource = textPoolImage(after, type);
  } catch {
    // Read-back failure: settle without afterSource rather than fake one.
  }
  await settle({
    outcome: "succeeded",
    activation: result.activation ? { attempted: true, activated: result.activation.activated } : { attempted: false },
    ...(afterSource !== undefined ? { afterSource } : {}),
  });
  return result;
}
