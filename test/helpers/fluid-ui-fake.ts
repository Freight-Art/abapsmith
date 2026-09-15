/**
 * Shared fake-ADT plumbing for the fluid `ui` tool's `screen` and `fcode`
 * actions, used by ui-runtime.test.ts, ui-system-key.test.ts,
 * ui-fcode.test.ts, ui-fcode-tool.test.ts, fluid-builtin-ui.test.ts and
 * integration-fluid-ui.test.ts. Modeled directly on
 * test/helpers/fluid-img-fake.ts. Three things live here:
 *
 * - `uiScreenConsole`: wraps a single already-built JSON payload (the shape
 *   `toUiTranscriptResult` in src/adt/ui-runtime.ts expects to reshape) into
 *   the fluid console frame grammar src/adt/fluid/protocol.ts expects.
 *   `uiManifest`'s `screen` action declares a `type: "object"` output, so
 *   `dispatch()` requires exactly one OUT value and hands it back verbatim as
 *   `res.result` — unlike img's array-of-string output (one OUT frame per
 *   line), ui's screen console carries exactly one OUT frame, whose payload
 *   is the whole object.
 *
 * - `uiFcodeConsole`: the `fcode` action's equivalent — `uiManifest`'s
 *   `fcode` action declares a `type: "array"` output, so `dispatch()` emits
 *   one OUT frame per element of the array and hands back `transcript.values`
 *   (every OUT frame, in order) as `res.result`, unlike `screen`'s single
 *   verbatim OUT payload.
 *
 * - `dynamicUiFluidRoute`: auto-vivifying class store for the two class
 *   shapes the fluid ui screen probe ever deploys — the fixed body class
 *   (`uiManifest.entry`) and the content-hash invoker `dispatch()` computes
 *   at runtime (`ZCL_ZMCP_I_[0-9A-F]{8}`, src/adt/fluid/invoke.ts). Same
 *   idiom as test/fluid-dispatch.test.ts's `dynamicFluidRoute`, generalized
 *   with `activationError`/`classrunOverride` hooks so the same store can
 *   also stand in for an activation-refusal or below-activation classrun
 *   failure. Returns `undefined` for anything it doesn't recognize (package
 *   existence, login, other bridge classes), so it composes as a fallback
 *   under each test file's own `baseRoute`.
 */
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { uiManifest, uiSources } from "../../src/adt/fluid/builtin/ui.js";
import { manifestVersion } from "../../src/adt/fluid/manifest.js";
import { FLUID_RUNTIME_CLASS } from "../../src/adt/fluid/abap/runtime.js";

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

function classDocXml(
  className: string,
  opts: { rootVersion?: string; mainVersion?: string; packageName?: string } = {},
): string {
  const root = opts.rootVersion ?? "active";
  const main = opts.mainVersion ?? root;
  const pkg = opts.packageName ?? "$TMP";
  const ver = (v: string) => ` adtcore:version="${v}"`;
  const inc = (type: string, version: string) =>
    `<class:include class:includeType="${type}" ` +
    `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
    `adtcore:name="" adtcore:type="CLAS/I"${ver(version)}/>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC"${ver(root)} ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/>` +
    inc("definitions", "active") +
    inc("implementations", "active") +
    inc("macros", "active") +
    inc("main", main) +
    `</class:abapClass>`
  );
}

function nameFromClassUrl(url: string): string | undefined {
  const prefix = "/sap/bc/adt/oo/classes/";
  if (!url.startsWith(prefix)) return undefined;
  const rest = url.slice(prefix.length);
  if (rest.endsWith("/source/main")) return rest.slice(0, -"/source/main".length).toUpperCase();
  if (rest.includes("/")) return undefined;
  return rest.toUpperCase();
}

/** The three class shapes the fluid ui screen probe ever deploys: the shared fluid runtime class, the fixed body class, or a content-hash invoker (src/adt/fluid/invoke.ts). Unlike test/helpers/fluid-img-fake.ts (which predates the runtime class being its own deployed manifest object and needs a separate runtimeClassRoute at each call site), this fake owns its own file and folds all three in here. */
export function isUiFluidClass(name: string): boolean {
  return name === uiManifest.entry || name === FLUID_RUNTIME_CLASS || /^ZCL_ZMCP_I_[0-9A-F]{8}$/.test(name);
}

export const uiManifestVersion: string = manifestVersion(uiManifest, uiSources);

/** A single `OUT` frame carrying `payload` whole, bracketed by BEGIN (id: "ui", action: "screen") and END — `ui.screen`'s output is `type: "object"`, so `dispatch()` requires exactly one OUT value and hands it back verbatim. */
export function uiScreenConsole(
  payload: Record<string, unknown>,
  opts: { ver?: string; rc?: number; truncated?: boolean } = {},
): string {
  const frame = (name: string, body: unknown) => `ZMCP-H>${name} ${JSON.stringify(body)}`;
  const raw = JSON.stringify(payload);
  const out = [
    frame("BEGIN", { id: "ui", action: "screen", ver: opts.ver ?? uiManifestVersion, contract: uiManifest.contract }),
    frame("OUT", payload),
    frame("END", { rc: opts.rc ?? 0, outBytes: raw.length, truncated: opts.truncated ?? false, ms: 1 }),
  ];
  return out.join("\n") + "\n";
}

/**
 * One `OUT` frame per element of `frames`, bracketed by BEGIN (id: "ui",
 * action: "fcode") and END — unlike `uiScreenConsole`, `ui.fcode`'s output is
 * `type: "array"` (`uiManifest.actions[1].output`), so `dispatch()` hands
 * back `transcript.values` (every OUT frame, in order) as the array result,
 * not a single verbatim payload.
 */
export function uiFcodeConsole(
  frames: readonly unknown[],
  opts: { ver?: string; rc?: number; truncated?: boolean } = {},
): string {
  const frame = (name: string, body: unknown) => `ZMCP-H>${name} ${JSON.stringify(body)}`;
  const raw = JSON.stringify(frames);
  const out = [
    frame("BEGIN", { id: "ui", action: "fcode", ver: opts.ver ?? uiManifestVersion, contract: uiManifest.contract }),
    ...frames.map((f) => frame("OUT", f)),
    frame("END", { rc: opts.rc ?? 0, outBytes: raw.length, truncated: opts.truncated ?? false, ms: 1 }),
  ];
  return out.join("\n") + "\n";
}

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

export interface UiFluidRouteOptions {
  /** classrun output for the invoker's execution — normally built with `uiScreenConsole`. */
  transcript: () => string;
  /** Bridge deploy package name embedded in class-create bodies and classDocXml's packageRef. */
  packageName: string;
  /** When set, activation of a class satisfying `matches` answers with this XML instead of a bare success — same shape as img-write.test.ts's bridgeActivationRefused/bridgeActivationDuplicateDeclaration. */
  activationError?: { matches: (className: string) => boolean; xml: (className: string) => string };
  /** When set, classrun for any fluid ui class is answered by this instead of `transcript()` — for a below-activation scaffold failure (e.g. classrun itself 500s). */
  classrunOverride?: (o: HttpClientOptions) => HttpClientResponse;
}

export function dynamicUiFluidRoute(
  opts: UiFluidRouteOptions,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const store = new Map<string, ObjState>();
  const at = (name: string): ObjState => {
    let st = store.get(name);
    if (!st) {
      st = { exists: false, packageName: "$TMP", active: false };
      store.set(name, st);
    }
    return st;
  };

  return (o: HttpClientOptions) => {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;

    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(o.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      if (!isUiFluidClass(name)) return undefined;
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: opts.packageName, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (o.url === "/sap/bc/adt/activation" && method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(o.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      if (!isUiFluidClass(name)) return undefined;
      if (opts.activationError?.matches(name)) return resp(200, opts.activationError.xml(name), OK_XML);
      const st = store.get(name);
      if (st) st.active = true;
      return resp(200, "", OK_TEXT);
    }

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      if (opts.classrunOverride) return opts.classrunOverride(o);
      return resp(200, opts.transcript(), OK_TEXT);
    }

    const name = nameFromClassUrl(o.url);
    if (name !== undefined && isUiFluidClass(name)) {
      const st = at(name);
      const isSrc = o.url.endsWith("/source/main");
      if (!isSrc && method === "GET" && !qs._action) {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (isSrc && method === "GET") {
        if (!st.exists || st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (!isSrc && qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (!isSrc && qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (isSrc && method === "PUT") {
        st.source = o.body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };
}
