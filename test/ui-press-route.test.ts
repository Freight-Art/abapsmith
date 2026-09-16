/**
 * Issue #150, item 2 — `mode:"press"` with program + dynpro and no tcode.
 * Decision (explained in the PR): not driveable. CALL SCREEN needs a GUI
 * session the ADT classrun bridge does not have, a class cannot CALL SCREEN
 * another program's dynpro, and a generated wrapper transaction in $TMP
 * would be a cross-client TSTC/TADIR object outside the typed safety gate.
 * So the refusal is explicit, structured, and costs zero wire requests —
 * it is raised by buildPressQuery before ensureConnected is even reached.
 */
import { describe, expect, it } from "vitest";
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { SCREEN_PAYLOAD } from "./helpers/ui-screen-fixture.js";
import { connected, errPayload, invoke, okText, registered, uiRoute } from "./helpers/ui-tool-harness.js";

const REFUSAL = "press needs tcode; program/dynpro is only supported by mode=screen";

/** Answers the connect handshake, then fails the test if anything else reaches the wire. */
function armedRoute(): { route: (o: HttpClientOptions) => HttpClientResponse; arm: () => void } {
  const live = uiRoute({ payload: SCREEN_PAYLOAD, tstc: [] });
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    route: (o) => {
      if (armed) throw new Error(`unexpected wire request ${o.method ?? "GET"} ${o.url}`);
      return live(o);
    },
  };
}

async function offline() {
  const { route, arm } = armedRoute();
  const { conn, inner } = await connected(route);
  arm();
  const tools = registered(conn, {
    ensureConnected: async () => {
      throw new Error("ensureConnected must not run for a query-shape refusal");
    },
  });
  return { tools, inner };
}

describe("abap_ui press: program + dynpro without tcode is refused before any network call", () => {
  it.each([
    ["program and dynpro", { program: "ZAS_GOLD", dynpro: "1000" }],
    ["program only", { program: "ZAS_GOLD" }],
    ["dynpro only", { dynpro: "1000" }],
  ])("%s → BAD_INPUT with the exact message", async (_label, target) => {
    const { tools, inner } = await offline();
    const err = errPayload(
      await invoke(tools, "abap_ui", {
        mode: "press",
        confirm: true,
        screens: [{ program: "ZAS_GOLD", dynpro: "1000", okcode: "=ONLI" }],
        ...target,
      }),
    );
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toBe(REFUSAL);
    expect(err.details).toMatchObject({ mode: "press", ...target });
    expect(err.hint).toContain('mode:"screen"');
    expect(inner.calls).toEqual([]);
  });

  it("without program/dynpro the refusal is still the plain 'requires tcode' one", async () => {
    const { tools, inner } = await offline();
    const err = errPayload(await invoke(tools, "abap_ui", { mode: "press", confirm: true }));
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toBe('mode:"press" requires tcode.');
    expect(inner.calls).toEqual([]);
  });

  it("confirm:false still loses to the confirm gate first (refusal order unchanged)", async () => {
    const { tools, inner } = await offline();
    const err = errPayload(await invoke(tools, "abap_ui", { mode: "press", program: "ZAS_GOLD", dynpro: "1000" }));
    expect(err.error).toBe("SAFETY_DENIED");
    expect(err.message).toContain("Pass confirm: true to proceed.");
    expect(inner.calls).toEqual([]);
  });
});

describe("abap_ui press: tcode routes as before", () => {
  it("with tcode present, program/dynpro on the call are ignored and the press runs", async () => {
    const { conn } = await connected(
      uiRoute({ payload: SCREEN_PAYLOAD, tstc: [{ TCODE: "ZAS_GOLD", PGMNA: "ZAS_GOLD", DYPNO: "1000", CINFO: "00" }] }),
    );
    const text = okText(
      await invoke(registered(conn), "abap_ui", {
        mode: "press",
        tcode: "ZAS_GOLD",
        program: "ZAS_GOLD",
        dynpro: "1000",
        confirm: true,
        screens: [{ program: "ZAS_GOLD", dynpro: "1000", okcode: "=ONLI" }],
      }),
    );
    expect(text).toContain("mode: press");
    expect(text).toContain("tcode: ZAS_GOLD");
  });

  it("mode=screen with the same program/dynpro is the supported route", async () => {
    const { conn } = await connected(uiRoute({ payload: SCREEN_PAYLOAD, tstc: [] }));
    const text = okText(await invoke(registered(conn), "abap_ui", { mode: "screen", program: "ZAS_GOLD", dynpro: "1000" }));
    expect(text).toContain("program: ZAS_GOLD");
    expect(text).toContain("dynpro: 1000");
  });
});
