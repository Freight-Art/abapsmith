/**
 * abapsmith's own release version. A leaf module — no imports, importable
 * from anywhere (including deep inside `adt/fluid/`) without dragging in the
 * MCP server or anything network-facing. `src/server.ts` re-exports this
 * constant so every existing `SERVER_VERSION` import keeps working.
 */
export const SERVER_VERSION = "0.3.0";
