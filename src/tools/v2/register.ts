/**
 * MCP registration for the six v2 tools: `abap_find`, `abap_read`, `abap_write`,
 * `abap_do`, `abap_debug`, `abap_adt`. Wires schema/annotations and dispatches
 * to each tool's handler under `handlers/`. Does not decide when it runs or
 * under what `ABAP_TOOL_SURFACE` (see `src/config.ts`, `src/server.ts`) —
 * it only acts on the mode it's handed via `deps.cfg.abapMode`.
 * `abap_adt`'s non-GET verbs remain `NOT_IMPLEMENTED` (`handlers/adt.ts`).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleAbapAdt } from "./handlers/adt.js";
import { handleAbapDebug } from "./handlers/debug.js";
import { handleAbapDo } from "./handlers/do.js";
import { handleAbapFind } from "./handlers/find.js";
import { handleAbapRead } from "./handlers/read.js";
import { handleAbapWrite } from "./handlers/write.js";
import type { V2ToolDeps } from "./runtime.js";
import {
  ABAP_ADT_DESCRIPTION,
  ABAP_DEBUG_DESCRIPTION,
  ABAP_FIND_DESCRIPTION,
  ABAP_READ_DESCRIPTION,
  ABAP_WRITE_DESCRIPTION,
  abapAdtInputSchema,
  abapDebugInputSchema,
  abapDoInputSchema,
  abapFindInputSchema,
  abapReadInputSchema,
  abapWriteInputSchema,
  buildAbapDoDescription,
} from "./schemas.js";

export type { V2ToolDeps } from "./runtime.js";

export function registerV2Tools(mcp: McpServer, deps: V2ToolDeps): void {
  const mode = deps.cfg.abapMode;

  mcp.registerTool(
    "abap_find",
    {
      description: ABAP_FIND_DESCRIPTION,
      inputSchema: abapFindInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    (args) => handleAbapFind(args, deps),
  );

  mcp.registerTool(
    "abap_read",
    {
      description: ABAP_READ_DESCRIPTION,
      inputSchema: abapReadInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    (args) => handleAbapRead(args, deps),
  );

  // abap_write is skipped in read mode (mode gating: mechanism 1 of 2).
  if (mode !== "read") {
    mcp.registerTool(
      "abap_write",
      {
        description: ABAP_WRITE_DESCRIPTION,
        inputSchema: abapWriteInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      (args) => handleAbapWrite(args, deps),
    );
  }

  mcp.registerTool(
    "abap_do",
    {
      description: buildAbapDoDescription(mode),
      inputSchema: abapDoInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => handleAbapDo(args, deps),
  );

  mcp.registerTool(
    "abap_debug",
    {
      description: ABAP_DEBUG_DESCRIPTION,
      inputSchema: abapDebugInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => handleAbapDebug(args, deps),
  );

  mcp.registerTool(
    "abap_adt",
    {
      description: ABAP_ADT_DESCRIPTION,
      inputSchema: abapAdtInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => handleAbapAdt(args, deps),
  );
}
