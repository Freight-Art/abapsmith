/**
 * Per-group unit tests for
 * `src/tools/v2/handlers/do/bopf.ts` (15 `bopf_*` actions).
 *
 * `runBopfRead`/`runBopfEdit`/`runBopfDelete`/`runBopfTest` are all
 * self-contained (own preflight/pool/safety internally — see bopf.ts's own
 * header) and return a `CallToolResult`, so these tests mock all four
 * directly and assert the v1 `bo`/`operation`/`mode` shape each `bopf_*`
 * action builds — including `bopf_delete`'s `dry_run` defaulting to `true`
 * when unspecified (the mandated non-obvious-default case for this group)
 * and `bopf_create`'s one rename (`bopf_create` -> v1 `operation: "create_bo"`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BOPF_HANDLERS } from "../src/tools/v2/handlers/do/bopf.js";
import type { BopfCallResult } from "../src/tools/bopf.js";
import { fakeDoDeps } from "./helpers/do-deps-fake.js";

vi.mock("../src/tools/bopf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/bopf.js")>()),
  runBopfRead: vi.fn(),
  runBopfEdit: vi.fn(),
  runBopfDelete: vi.fn(),
}));
vi.mock("../src/tools/bopf-test.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/bopf-test.js")>()),
  runBopfTest: vi.fn(),
}));

const okResult = (text = "ok"): CallToolResult => ({ content: [{ type: "text", text }] });

describe("abap_do bopf group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bopf_check_refs: object maps to v1 `bo`, mode forced to \"check_refs\"", async () => {
    const { runBopfRead } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfRead).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_check_refs")!({ action: "bopf_check_refs", object: "ZBOPF_FOO", args: {} }, deps);

    const [, input] = vi.mocked(runBopfRead).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO", mode: "check_refs" });
  });

  it("bopf_create: v1 operation is \"create_bo\" (the one rename in the set)", async () => {
    const { runBopfEdit } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfEdit).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_create")!(
      { action: "bopf_create", object: "ZBOPF_FOO", args: { package: "$TMP" } },
      deps,
    );

    const [, input] = vi.mocked(runBopfEdit).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO", operation: "create_bo", package: "$TMP" });
  });

  it("bopf_add_node: v1 operation strips the bopf_ prefix verbatim", async () => {
    const { runBopfEdit } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfEdit).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_add_node")!(
      { action: "bopf_add_node", object: "ZBOPF_FOO", args: { node: "ROOT", name: "ITEM" } },
      deps,
    );

    const [, input] = vi.mocked(runBopfEdit).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO", operation: "add_node", node: "ROOT", name: "ITEM" });
  });

  it("bopf_add_alternative_key: i_know_this_may_not_activate passes through unenforced here (v1 enforces it)", async () => {
    const { runBopfEdit } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfEdit).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_add_alternative_key")!(
      { action: "bopf_add_alternative_key", object: "ZBOPF_FOO", args: { node: "ROOT", i_know_this_may_not_activate: true } },
      deps,
    );

    const [, input] = vi.mocked(runBopfEdit).mock.calls[0]!;
    expect(input).toMatchObject({
      bo: "ZBOPF_FOO",
      operation: "add_alternative_key",
      i_know_this_may_not_activate: true,
    });
  });

  it("bopf_delete: dry_run unspecified is left unset in the v1 input (v1's own default of true applies)", async () => {
    const { runBopfDelete } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfDelete).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_delete")!({ action: "bopf_delete", object: "ZBOPF_FOO", args: {} }, deps);

    const [, input] = vi.mocked(runBopfDelete).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO" });
    expect((input as Record<string, unknown>).dry_run).toBeUndefined();
  });

  it("bopf_delete: ctx.dry_run:false is folded into args.dry_run explicitly", async () => {
    const { runBopfDelete } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfDelete).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_delete")!(
      { action: "bopf_delete", object: "ZBOPF_FOO", args: {}, dry_run: false, confirm: "ZBOPF_FOO" },
      deps,
    );

    const [, input] = vi.mocked(runBopfDelete).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO", dry_run: false, confirm: "ZBOPF_FOO" });
  });

  it("bopf_test: object maps to v1 `bo`, routes to runBopfTest (a third v1 function)", async () => {
    const { runBopfTest } = await import("../src/tools/bopf-test.js");
    vi.mocked(runBopfTest).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_test")!(
      { action: "bopf_test", object: "ZBOPF_FOO", args: { scenario: { nodes: [{ node: "ROOT", fields: {} }] } } },
      deps,
    );

    const [, input] = vi.mocked(runBopfTest).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO" });
  });

  it("bopf_activate: object maps to v1 `bo`, operation forced to \"activate\"", async () => {
    const { runBopfEdit } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfEdit).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    await BOPF_HANDLERS.get("bopf_activate")!({ action: "bopf_activate", object: "ZBOPF_FOO", args: {} }, deps);

    const [, input] = vi.mocked(runBopfEdit).mock.calls[0]!;
    expect(input).toMatchObject({ bo: "ZBOPF_FOO", operation: "activate" });
  });

  // =========================================================================
  // G3b: `journalNext()` ("See this change recorded in the journal.")
  // must only be offered when an entry actually exists — never unconditionally.
  // `runBopfEdit`/`runBopfDelete` (src/tools/bopf.ts) surface that as the
  // INTERNAL `BopfCallResult.journalEntryId` field when (and only when) they
  // wrote one — NOT `structuredContent` (a sibling defect: putting the
  // id there made an MCP client that prefers `structuredContent` over
  // `content` show it instead of the result text on every journalling call).
  // =========================================================================

  const withEntryId = (id: string): BopfCallResult => ({
    content: [{ type: "text", text: "ok" }],
    journalEntryId: id,
  });

  it("bopf_add_node: offers journal_list as next when runBopfEdit reports a journalEntryId", async () => {
    const { runBopfEdit } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfEdit).mockResolvedValue(withEntryId("ent-1"));
    const deps = fakeDoDeps();

    const res = await BOPF_HANDLERS.get("bopf_add_node")!(
      { action: "bopf_add_node", object: "ZBOPF_FOO", args: { node: "ROOT", name: "ITEM" } },
      deps,
    );

    expect(res.next).toEqual([{ tool: "abap_do", args: { action: "journal_list" }, why: expect.any(String) }]);
  });

  it("bopf_activate: offers no journal_list next — runBopfEdit reports no journalEntryId (nothing was written)", async () => {
    const { runBopfEdit } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfEdit).mockResolvedValue(okResult()); // no structuredContent at all
    const deps = fakeDoDeps();

    const res = await BOPF_HANDLERS.get("bopf_activate")!({ action: "bopf_activate", object: "ZBOPF_FOO", args: {} }, deps);

    expect(res.next).toEqual([]);
  });

  it("bopf_delete: offers journal_list as next when runBopfDelete reports a journalEntryId (an armed delete)", async () => {
    const { runBopfDelete } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfDelete).mockResolvedValue(withEntryId("ent-2"));
    const deps = fakeDoDeps();

    const res = await BOPF_HANDLERS.get("bopf_delete")!(
      { action: "bopf_delete", object: "ZBOPF_FOO", args: {}, dry_run: false, confirm: "ZBOPF_FOO" },
      deps,
    );

    expect(res.next).toEqual([{ tool: "abap_do", args: { action: "journal_list" }, why: expect.any(String) }]);
  });

  it("bopf_delete: offers no journal_list next on a dry run — runBopfDelete reports no journalEntryId", async () => {
    const { runBopfDelete } = await import("../src/tools/bopf.js");
    vi.mocked(runBopfDelete).mockResolvedValue(okResult());
    const deps = fakeDoDeps();

    const res = await BOPF_HANDLERS.get("bopf_delete")!({ action: "bopf_delete", object: "ZBOPF_FOO", args: {} }, deps);

    expect(res.next).toEqual([]);
  });
});
