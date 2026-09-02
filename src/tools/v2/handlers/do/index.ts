/**
 * Merged dispatch table for `abap_do`: all 45 actions from the six group
 * modules, keyed by `action`. `handlers/do.ts` just looks up the action here.
 *
 * Keyset MUST equal `ABAP_DO_ACTIONS.map(e => e.action)` from
 * `../../catalogue.js` — enforced only by test/tools-v2-do-invariant.test.ts,
 * not by a runtime assertion here (would tax every test for one test's check).
 */
import { ACTIVATION_HANDLERS } from "./activation.js";
import { EXECUTION_HANDLERS } from "./execution.js";
import { JOURNAL_HANDLERS } from "./journal.js";
import { TRANSPORT_HANDLERS } from "./transports.js";
import { BOPF_HANDLERS } from "./bopf.js";
import { ENHANCEMENT_HANDLERS } from "./enhancements.js";
import type { DoHandler } from "./types.js";

export const DO_HANDLERS: ReadonlyMap<string, DoHandler> = new Map<string, DoHandler>([
  ...ACTIVATION_HANDLERS,
  ...EXECUTION_HANDLERS,
  ...JOURNAL_HANDLERS,
  ...TRANSPORT_HANDLERS,
  ...BOPF_HANDLERS,
  ...ENHANCEMENT_HANDLERS,
]);

export type { DoContext, DoHandler } from "./types.js";
