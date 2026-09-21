/**
 * Issue #150, item 3 — the TSTC pre-check. Every tcode-addressed abap_ui
 * call (`screen`/`fcode` by tcode, and `press`) first runs one catalog
 * select against TSTC on the read lane (src/adt/ui-tstc.ts) and refuses a
 * transaction with no row as a structured NOT_FOUND before any bridge class
 * is deployed or run. Before this, a bogus tcode cost a full fluid-invoker
 * deploy + activate + classrun (~20 s live) to learn the same thing.
 *
 * `press` additionally reads CINFO from that same row (assertBdcApplies is
 * now pure), so the second screen-mode bridge run it used to pay for the
 * CINFO check is gone: a press deploys exactly one class, its own
 * `zcl_zmcp_ui_<hash>` BDCDATA bridge, and never a fluid `ZCL_ZMCP_I_...`
 * invoker.
 */
import { describe, expect, it } from "vitest";
import type { HttpClientOptions } from "abap-adt-api/build/AdtHTTP.js";

import { lookupTransaction, tstcKind } from "../src/adt/ui-tstc.js";
import { SCREEN_PAYLOAD } from "./helpers/ui-screen-fixture.js";
import { isTstcSelect, type TstcRow } from "./helpers/tstc-select-fake.js";
import { isUiFluidClass } from "./helpers/fluid-ui-fake.js";
import {
  CLASS_COLLECTION,
  CLASSRUN_PREFIX,
  connected,
  errPayload,
  invoke,
  okText,
  registered,
  uiRoute,
} from "./helpers/ui-tool-harness.js";

const DIALOG: TstcRow = { TCODE: "ZAS_GOLD", PGMNA: "ZAS_GOLD", DYPNO: "1000", CINFO: "00" };
const REPORT: TstcRow = { TCODE: "ZAS_REP", PGMNA: "ZAS_REP", DYPNO: "1000", CINFO: "80" };

const PRESS_ARGS = {
  mode: "press",
  confirm: true,
  screens: [{ program: "ZAS_GOLD", dynpro: "1000", okcode: "=ONLI" }],
};

/** Wire evidence that a bridge class was created, activated or run. */
function bridgeCalls(calls: readonly HttpClientOptions[]): HttpClientOptions[] {
  return calls.filter(
    (c) =>
      c.url.startsWith(CLASS_COLLECTION) || c.url.startsWith(CLASSRUN_PREFIX) || c.url.includes("/sap/bc/adt/activation"),
  );
}

describe("lookupTransaction — one data-preview select, typed row or undefined", () => {
  it("returns the TSTC row with the same kind strings the bridge's ABAP uses", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [DIALOG] }));
    const record = await lookupTransaction(conn, "zas_gold");
    expect(record).toEqual({
      tcode: "ZAS_GOLD",
      program: "ZAS_GOLD",
      dynpro: "1000",
      cinfo: "00",
      kind: "dialog transaction (classic dynpro; batch input / press applies)",
      bdcApplies: true,
    });
    expect(inner.calls).toHaveLength(1);
    expect(isTstcSelect(inner.calls[0])).toBe(true);
    expect(inner.calls[0]?.body).toContain("WHERE TCODE IN ('ZAS_GOLD')");
  });

  it("returns undefined for a transaction TSTC does not have, and refuses a malformed code before the wire", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [] }));
    expect(await lookupTransaction(conn, "ZAS_NO_SUCH_TC")).toBeUndefined();
    expect(inner.calls).toHaveLength(1);
    inner.calls.length = 0;
    await expect(lookupTransaction(conn, "BAD'CODE")).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(inner.calls).toHaveLength(0);
  });

  it("tstcKind mirrors resolve_target in the fluid ui ABAP", () => {
    expect(tstcKind("00")).toBe("dialog transaction (classic dynpro; batch input / press applies)");
    expect(tstcKind("80")).toBe("report transaction (SUBMIT-driven; batch input does NOT apply)");
    expect(tstcKind("01")).toBe(
      "unrecognised transaction kind - mechanism not confirmed, do not assume batch input applies",
    );
  });
});

describe("abap_ui: a tcode with no TSTC row is NOT_FOUND after one select and zero bridge calls", () => {
  it.each([
    ["screen", { mode: "screen", tcode: "ZAS_NO_SUCH_TC" }],
    ["fcode", { mode: "fcode", tcode: "ZAS_NO_SUCH_TC" }],
    ["press", { ...PRESS_ARGS, tcode: "ZAS_NO_SUCH_TC" }],
  ])("mode=%s", async (_mode, args) => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [] }));
    const tools = registered(conn);

    const err = errPayload(await invoke(tools, "abap_ui", args));
    expect(err.error).toBe("NOT_FOUND");
    expect(err.message).toBe("transaction ZAS_NO_SUCH_TC does not exist");
    expect(err.details).toMatchObject({ tcode: "ZAS_NO_SUCH_TC", table: "TSTC" });
    expect(err.hint).toContain("no bridge class was deployed");

    expect(inner.calls).toHaveLength(1);
    expect(isTstcSelect(inner.calls[0])).toBe(true);
    expect(bridgeCalls(inner.calls)).toEqual([]);
  });

  it("normalises the code the way the query does (lower case, padding) before the select and in the message", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [] }));
    const err = errPayload(await invoke(registered(conn), "abap_ui", { mode: "screen", tcode: " zas_no_such_tc " }));
    expect(err.message).toBe("transaction ZAS_NO_SUCH_TC does not exist");
    expect(inner.calls[0]?.body).toContain("WHERE TCODE IN ('ZAS_NO_SUCH_TC')");
  });

  it("does not run for program+dynpro screen reads (nothing to look up)", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [] }));
    okText(await invoke(registered(conn), "abap_ui", { mode: "screen", program: "ZAS_GOLD", dynpro: "1000" }));
    expect(inner.calls.some((c) => isTstcSelect(c))).toBe(false);
  });
});

describe("abap_ui screen by tcode: an existing transaction passes the pre-check and reads the screen", () => {
  it("performs the select first, then the fluid bridge, and renders the tcode header", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [DIALOG] }));
    const text = okText(await invoke(registered(conn), "abap_ui", { mode: "screen", tcode: "ZAS_GOLD" }));
    expect(text).toContain("tcode: ZAS_GOLD");
    expect(text).toContain("cinfo: 00");
    expect(isTstcSelect(inner.calls[0])).toBe(true);
    expect(bridgeCalls(inner.calls).length).toBeGreaterThan(0);
  });
});

describe("abap_ui press: CINFO comes from the pre-check row, not a second bridge run", () => {
  it("refuses a report transaction (CINFO 80) as SAFETY_DENIED with zero bridge calls", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [REPORT] }));
    const err = errPayload(await invoke(registered(conn), "abap_ui", { ...PRESS_ARGS, tcode: "ZAS_REP" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(err.message).toContain("Transaction ZAS_REP has TSTC-CINFO=80");
    expect(err.message).toContain("Use abap_run (report mode) or SUBMIT instead.");
    expect(err.details).toMatchObject({
      tcode: "ZAS_REP",
      cinfo: "80",
      kind: "report transaction (SUBMIT-driven; batch input does NOT apply)",
      phase: "preflight",
    });
    expect(inner.calls).toHaveLength(1);
    expect(bridgeCalls(inner.calls)).toEqual([]);
  });

  it("refuses an unrecognised CINFO conservatively, still with zero bridge calls", async () => {
    const { conn, inner } = await connected(
      uiRoute({ payload: SCREEN_PAYLOAD, tstc: [{ ...DIALOG, TCODE: "ZAS_ODD", CINFO: "01" }] }),
    );
    const err = errPayload(await invoke(registered(conn), "abap_ui", { ...PRESS_ARGS, tcode: "ZAS_ODD" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(err.details).toMatchObject({ cinfo: "01", phase: "preflight" });
    expect(bridgeCalls(inner.calls)).toEqual([]);
  });

  it("on a dialog transaction deploys only its own zcl_zmcp_ui_ bridge — never a fluid invoker", async () => {
    const { conn, inner } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [DIALOG] }));
    const text = okText(await invoke(registered(conn), "abap_ui", { ...PRESS_ARGS, tcode: "ZAS_GOLD" }));
    expect(text).toContain("mode: press");
    expect(text).toContain("subrc: 0");

    expect(isTstcSelect(inner.calls[0])).toBe(true);
    const classruns = inner.calls.filter((c) => c.url.startsWith(CLASSRUN_PREFIX));
    expect(classruns).toHaveLength(1);
    const ran = classruns[0]?.url.slice(CLASSRUN_PREFIX.length).toUpperCase() ?? "";
    expect(ran).toMatch(/^ZCL_ZMCP_UI_[0-9A-F]+$/);
    expect(isUiFluidClass(ran)).toBe(false);
    for (const c of inner.calls.filter((c) => c.url.startsWith(`${CLASS_COLLECTION}/`))) {
      const name = c.url.slice(CLASS_COLLECTION.length + 1).split("/")[0]?.toUpperCase() ?? "";
      expect(isUiFluidClass(name)).toBe(false);
    }
    // and exactly one select — the pre-check is not repeated by the CINFO check
    expect(inner.calls.filter((c) => isTstcSelect(c))).toHaveLength(1);
  });
});
