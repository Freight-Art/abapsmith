/**
 * Shared fake-ADT plumbing for the fluid `enh` tool's five mutating actions
 * (`create_spot`, `add_badi_def`, `add_filter_def`, `create_impl`,
 * `set_filter_values`), used by `test/enhancement-bridge.test.ts` and
 * `test/enhancement-tools.test.ts`. Modeled directly on
 * `test/helpers/fluid-img-fake.ts`'s `dynamicImgFluidRoute`/`imgProbeConsole`
 * pair, with two differences the `enh` manifest's own shape forces:
 *
 * - `enh`'s manifest declares TWO fixed body objects (the shared
 *   `FLUID_RUNTIME_CLASS`, deployed first, and `ZCL_ZMCP_FLUID_ENH` itself),
 *   not img's one — see `src/adt/fluid/ensure.ts`'s in-order deploy and
 *   `test/img-write.test.ts`'s own `runtimeClassRoute` comment for why a
 *   fake that only recognizes the entry class's own name leaves the runtime
 *   class's lifecycle unrouted. `isEnhFluidClass` recognizes all three
 *   shapes (both fixed names, plus the content-hash invoker) so one store
 *   handles every class the fluid `enh` deploy path ever touches.
 * - `enh`'s five actions all declare an `object`-typed output (one JSON
 *   value), not img's array-of-string-lines — so `enhProbeConsole` emits
 *   exactly ONE `OUT` frame carrying `JSON.stringify(result)`, not one frame
 *   per line.
 */
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { FLUID_RUNTIME_CLASS } from "../../src/adt/fluid/abap/runtime.js";
import { enhManifest, enhSources } from "../../src/adt/fluid/builtin/enh.js";
import { manifestVersion } from "../../src/adt/fluid/manifest.js";

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

/**
 * The three class shapes the fluid `enh` deploy path ever touches: the
 * shared runtime class, the fixed `enh` body class, or a content-hash
 * invoker (`src/adt/fluid/invoke.ts`).
 */
export function isEnhFluidClass(name: string): boolean {
  return name === FLUID_RUNTIME_CLASS || name === enhManifest.entry || /^ZCL_ZMCP_I_[0-9A-F]{8}$/.test(name);
}

export const enhManifestVersion: string = manifestVersion(enhManifest, enhSources);

/**
 * One `OUT` frame carrying `JSON.stringify(result)`, bracketed by BEGIN (id:
 * "enh", action) and END — `enh`'s actions all declare an `object`-typed
 * output, so `dispatch()` expects exactly one OUT frame, not one per line.
 */
export function enhProbeConsole(
  action: string,
  result: Record<string, unknown>,
  opts: { ver?: string; rc?: number; truncated?: boolean } = {},
): string {
  const frame = (name: string, payload: unknown) => `ZMCP-H>${name} ${JSON.stringify(payload)}`;
  const out = [
    frame("BEGIN", { id: "enh", action, ver: opts.ver ?? enhManifestVersion, contract: enhManifest.contract }),
    frame("OUT", result),
    frame("END", { rc: opts.rc ?? 0, outBytes: JSON.stringify(result).length, truncated: opts.truncated ?? false, ms: 1 }),
  ];
  return out.join("\n") + "\n";
}

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

export interface EnhFluidRouteOptions {
  /** classrun output for the invoker's execution — normally built with `enhProbeConsole`. */
  transcript: () => string;
  /** Bridge deploy package name embedded in class-create bodies and classDocXml's packageRef. */
  packageName: string;
  /** When set, activation of a class satisfying `matches` answers with this XML instead of a bare success. */
  activationError?: { matches: (className: string) => boolean; xml: (className: string) => string };
  /** When set, classrun for any fluid enh class is answered by this instead of `transcript()`. */
  classrunOverride?: (o: HttpClientOptions) => HttpClientResponse;
}

/**
 * Auto-vivifying class store for every class name `isEnhFluidClass`
 * recognizes — same idiom as `fluid-img-fake.ts`'s `dynamicImgFluidRoute`,
 * generalized to cover `enh`'s two fixed body objects plus the invoker in
 * one function instead of needing a second, separately-maintained
 * runtime-class route composed alongside it. Returns `undefined` for
 * anything it doesn't recognize (package existence, login, other bridge
 * classes), so it composes as a fallback under each test file's own base
 * route.
 */
export function dynamicEnhFluidRoute(
  opts: EnhFluidRouteOptions,
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
      if (!isEnhFluidClass(name)) return undefined;
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: opts.packageName, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (o.url === "/sap/bc/adt/activation" && method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(o.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      if (!isEnhFluidClass(name)) return undefined;
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
    if (name !== undefined && isEnhFluidClass(name)) {
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
