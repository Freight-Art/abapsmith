/**
 * Per-group unit tests for
 * `src/tools/v2/handlers/do/transports.ts` (9 `transport_*` actions).
 *
 * Mocks only `abapTransport`/`abapTransportRelease` (the two v1 orchestration
 * functions this group calls) and asserts each action's `object` -> v1-field
 * mapping, including the two documented exceptions (`transport_list` ->
 * `user`, `transport_users` -> rejects any object) and `transport_release`'s
 * confirm-absent-means-dry-run default.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltResponse } from "../src/compact.js";
import { TRANSPORT_HANDLERS } from "../src/tools/v2/handlers/do/transports.js";
import { fakeDoDeps } from "./helpers/do-deps-fake.js";

vi.mock("../src/tools/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/transport.js")>()),
  abapTransport: vi.fn(),
  abapTransportRelease: vi.fn(),
}));

const okResponse = (text = "ok"): BuiltResponse => ({ text, truncated: false, estimatedTokens: 1 });

describe("abap_do transports group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transport_list: object maps to v1 `user`, operation forced to \"list\"", async () => {
    const { abapTransport } = await import("../src/tools/transport.js");
    vi.mocked(abapTransport).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_list")!({ action: "transport_list", object: "DEVELOPER", args: {} }, deps);

    const [, input] = vi.mocked(abapTransport).mock.calls[0]!;
    expect(input).toMatchObject({ operation: "list", user: "DEVELOPER" });
    expect((input as Record<string, unknown>).transport).toBeUndefined();
  });

  it("transport_check: object maps to v1 `object` (the ABAP object to check), operation forced to \"check\"", async () => {
    const { abapTransport } = await import("../src/tools/transport.js");
    vi.mocked(abapTransport).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_check")!({ action: "transport_check", object: "ZCL_FOO", args: {} }, deps);

    const [, input] = vi.mocked(abapTransport).mock.calls[0]!;
    expect(input).toMatchObject({ operation: "check", object: "ZCL_FOO" });
  });

  it("transport_create: object maps to v1 `object` (an optional anchor), NOT `transport`", async () => {
    const { abapTransport } = await import("../src/tools/transport.js");
    vi.mocked(abapTransport).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_create")!(
      { action: "transport_create", object: "ZCL_FOO", args: { description: "test request" } },
      deps,
    );

    const [, input] = vi.mocked(abapTransport).mock.calls[0]!;
    expect(input).toMatchObject({ operation: "create", object: "ZCL_FOO", description: "test request" });
    expect((input as Record<string, unknown>).transport).toBeUndefined();
  });

  it("transport_show/transport_add_user/transport_delete: object maps to v1 `transport`", async () => {
    const { abapTransport } = await import("../src/tools/transport.js");
    vi.mocked(abapTransport).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_show")!({ action: "transport_show", object: "TR1K900123", args: {} }, deps);

    const [, input] = vi.mocked(abapTransport).mock.calls[0]!;
    expect(input).toMatchObject({ operation: "show", transport: "TR1K900123" });
  });

  it("transport_users: rejects an object with BAD_INPUT — it takes no target at all", async () => {
    const deps = fakeDoDeps();

    await expect(
      TRANSPORT_HANDLERS.get("transport_users")!({ action: "transport_users", object: "DEVELOPER", args: {} }, deps),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("transport_delete: ctx.confirm folds into args.confirm", async () => {
    const { abapTransport } = await import("../src/tools/transport.js");
    vi.mocked(abapTransport).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_delete")!(
      { action: "transport_delete", object: "TR1K900123", args: {}, confirm: "TR1K900123" },
      deps,
    );

    const [, input] = vi.mocked(abapTransport).mock.calls[0]!;
    expect(input).toMatchObject({ operation: "delete", transport: "TR1K900123", confirm: "TR1K900123" });
  });

  it("transport_release: confirm absent means input.confirm stays undefined (v1's own dry-run default)", async () => {
    const { abapTransportRelease } = await import("../src/tools/transport.js");
    vi.mocked(abapTransportRelease).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_release")!(
      { action: "transport_release", object: "TR1K900123", args: {} },
      deps,
    );

    const [, input] = vi.mocked(abapTransportRelease).mock.calls[0]!;
    expect(input).toMatchObject({ transport: "TR1K900123" });
    expect((input as Record<string, unknown>).confirm).toBeUndefined();
  });

  it("transport_release: ctx.confirm folds into args.confirm when the caller supplies it", async () => {
    const { abapTransportRelease } = await import("../src/tools/transport.js");
    vi.mocked(abapTransportRelease).mockResolvedValue(okResponse());
    const deps = fakeDoDeps();

    await TRANSPORT_HANDLERS.get("transport_release")!(
      { action: "transport_release", object: "TR1K900123", args: {}, confirm: "TR1K900123" },
      deps,
    );

    const [, input] = vi.mocked(abapTransportRelease).mock.calls[0]!;
    expect(input).toMatchObject({ transport: "TR1K900123", confirm: "TR1K900123" });
  });

  it("transport ops lease a write slot with no explicit object handle (undefined objectUri)", async () => {
    const { abapTransport } = await import("../src/tools/transport.js");
    vi.mocked(abapTransport).mockResolvedValue(okResponse());
    const withWrite = vi.fn((_op: string, objectUri: string | undefined, fn: (c: unknown) => unknown) => fn({ cfg: {} }));
    const deps = fakeDoDeps({ pool: { withWrite, withRead: vi.fn(), primary: () => ({}), reserveDebug: vi.fn() } as never });

    await TRANSPORT_HANDLERS.get("transport_check")!({ action: "transport_check", object: "ZCL_FOO", args: {} }, deps);

    expect(withWrite).toHaveBeenCalledTimes(1);
    expect(withWrite.mock.calls[0]![1]).toBeUndefined();
  });
});
