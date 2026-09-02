/**
 * Per-group unit tests for
 * `src/tools/v2/handlers/do/enhancements.ts` (9 `enh_*` actions).
 *
 * `enh_write_description` reimplements its v1 registrar's choreography
 * locally (`writeEnhancementDescription` + `activateObject`, mocked here);
 * the other 8 actions call `runEnhCreateOperation`/`runEnhHookOperation`
 * (also mocked) directly. Every action maps `object` -> v1 `name` without
 * exception (see the module's own header) — these tests assert that
 * uniformly, plus the `operation` derivation (a straight `enh_` prefix strip
 * for 8 of 9, `enh_write_description` -> v1's default/omitted operation).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ENHANCEMENT_HANDLERS } from "../src/tools/v2/handlers/do/enhancements.js";
import { withField, withObject, withValue } from "../src/tools/v2/handlers/do/shared.js";
import { fakeDoDeps } from "./helpers/do-deps-fake.js";

vi.mock("../src/tools/enh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/enh.js")>()),
  runEnhCreateOperation: vi.fn(),
  runEnhHookOperation: vi.fn(),
}));
vi.mock("../src/adt/enhancement-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/enhancement-write.js")>()),
  writeEnhancementDescription: vi.fn(),
}));
vi.mock("../src/adt/activate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/activate.js")>()),
  activateObject: vi.fn(),
}));

const okResult = (text = "ok"): CallToolResult => ({ content: [{ type: "text", text }] });

const fakeWriteResult = () => ({
  target: { type: "ENHO/XHH", name: "ZENH_FOO", uri: "/x", packageName: "$TMP", masterSystem: "A4H" },
  affects: { name: "ZCL_HOST", packageName: "$TMP" },
  changed: true,
  etag: "etag2",
  previousEtag: "etag1",
  transport: { status: "local" },
  previousXml: "<x/>",
  xml: "<x/>",
  putVerified: true,
});

describe("abap_do enhancements group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enh_create_spot: object maps to v1 `name`, operation forced to \"create_spot\"", async () => {
    const { runEnhCreateOperation } = await import("../src/tools/enh.js");
    vi.mocked(runEnhCreateOperation).mockResolvedValue("ok");
    const deps = fakeDoDeps();

    await ENHANCEMENT_HANDLERS.get("enh_create_spot")!(
      { action: "enh_create_spot", object: "ZSPOT_FOO", args: { spec: {} } },
      deps,
    );

    expect(runEnhCreateOperation).toHaveBeenCalledTimes(1);
    const [, operation, input] = vi.mocked(runEnhCreateOperation).mock.calls[0]!;
    expect(operation).toBe("create_spot");
    expect(input).toMatchObject({ name: "ZSPOT_FOO", operation: "create_spot" });
  });

  it("enh_exercise: object maps to v1 `name` (the BAdI definition's badiName)", async () => {
    const { runEnhCreateOperation } = await import("../src/tools/enh.js");
    vi.mocked(runEnhCreateOperation).mockResolvedValue("ok");
    const deps = fakeDoDeps();

    await ENHANCEMENT_HANDLERS.get("enh_exercise")!(
      { action: "enh_exercise", object: "ZBADI_FOO", args: { spec: { methodName: "IF_FOO~BAR" } } },
      deps,
    );

    const [, operation, input] = vi.mocked(runEnhCreateOperation).mock.calls[0]!;
    expect(operation).toBe("exercise");
    expect(input).toMatchObject({ name: "ZBADI_FOO" });
  });

  it("enh_discover_hook_anchors: routes to runEnhHookOperation, next points at enh_create_hook", async () => {
    const { runEnhHookOperation } = await import("../src/tools/enh.js");
    vi.mocked(runEnhHookOperation).mockResolvedValue("anchors...");
    const deps = fakeDoDeps();

    const res = await ENHANCEMENT_HANDLERS.get("enh_discover_hook_anchors")!(
      { action: "enh_discover_hook_anchors", object: "ZPROG_FOO", args: { spec: { hostType: "PROG/P", hostName: "ZPROG_FOO", hostUri: "/x" } } },
      deps,
    );

    const [, operation, input] = vi.mocked(runEnhHookOperation).mock.calls[0]!;
    expect(operation).toBe("discover_hook_anchors");
    expect(input).toMatchObject({ name: "ZPROG_FOO" });
    expect(res.next).toEqual([
      { tool: "abap_do", args: { action: "enh_create_hook" }, why: "Create a hook bound to one of these anchors." },
    ]);
  });

  it("enh_create_hook: routes to runEnhHookOperation with no extra next hint", async () => {
    const { runEnhHookOperation } = await import("../src/tools/enh.js");
    vi.mocked(runEnhHookOperation).mockResolvedValue("created");
    const deps = fakeDoDeps();

    const res = await ENHANCEMENT_HANDLERS.get("enh_create_hook")!(
      { action: "enh_create_hook", object: "ZENH_HOOK", args: {} },
      deps,
    );

    const [, operation] = vi.mocked(runEnhHookOperation).mock.calls[0]!;
    expect(operation).toBe("create_hook");
    expect(res.next).toEqual([]);
  });

  it("enh_write_description: object maps to v1 `name`, operation defaults to write_description (omitted)", async () => {
    const { writeEnhancementDescription } = await import("../src/adt/enhancement-write.js");
    vi.mocked(writeEnhancementDescription).mockResolvedValue(fakeWriteResult() as never);
    const deps = fakeDoDeps();

    await ENHANCEMENT_HANDLERS.get("enh_write_description")!(
      {
        action: "enh_write_description",
        object: "ZENH_FOO",
        args: { type: "ENHO/XHH", description: "new desc", affects: { name: "ZCL_HOST", packageName: "$TMP", masterSystem: "A4H" } },
      },
      deps,
    );

    expect(writeEnhancementDescription).toHaveBeenCalledTimes(1);
    const [, , writeArg] = vi.mocked(writeEnhancementDescription).mock.calls[0]!;
    expect(writeArg).toMatchObject({ type: "ENHO/XHH", name: "ZENH_FOO", description: "new desc" });
  });

  it("enh_write_description: missing description throws BAD_INPUT before ever calling the v1 writer", async () => {
    const { writeEnhancementDescription } = await import("../src/adt/enhancement-write.js");
    const deps = fakeDoDeps();

    await expect(
      ENHANCEMENT_HANDLERS.get("enh_write_description")!(
        { action: "enh_write_description", object: "ZENH_FOO", args: { type: "ENHO/XHH", affects: { name: "ZCL_HOST", packageName: "$TMP" } } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(writeEnhancementDescription).not.toHaveBeenCalled();
  });

  it("enh_write_description: missing affects throws BAD_INPUT (required for every action but discover_hook_anchors)", async () => {
    const deps = fakeDoDeps();

    await expect(
      ENHANCEMENT_HANDLERS.get("enh_write_description")!(
        { action: "enh_write_description", object: "ZENH_FOO", args: { type: "ENHO/XHH", description: "x" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("object and args.name disagreeing throws BAD_INPUT, never silently picks a winner", async () => {
    const deps = fakeDoDeps();

    await expect(
      ENHANCEMENT_HANDLERS.get("enh_create_spot")!(
        { action: "enh_create_spot", object: "ZSPOT_FOO", args: { name: "ZSPOT_BAR" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

describe("shared do-handler helpers do not mutate the caller's args", () => {
  it("withObject leaves the frozen input object untouched", () => {
    const args = Object.freeze({ spec: {} });
    const merged = withObject(args, "name", "ZSPOT_FOO");
    expect(merged).toEqual({ spec: {}, name: "ZSPOT_FOO" });
    expect(args).toEqual({ spec: {} });
  });

  it("withField leaves the frozen input object untouched", () => {
    const args = Object.freeze({ name: "ZSPOT_FOO" });
    const merged = withField(args, "operation", "create_spot");
    expect(merged).toEqual({ name: "ZSPOT_FOO", operation: "create_spot" });
    expect(args).toEqual({ name: "ZSPOT_FOO" });
  });

  it("withValue leaves the frozen input object untouched", () => {
    const args = Object.freeze({ name: "ZSPOT_FOO" });
    const merged = withValue(args, "confirm", "yes");
    expect(merged).toEqual({ name: "ZSPOT_FOO", confirm: "yes" });
    expect(args).toEqual({ name: "ZSPOT_FOO" });
  });
});
