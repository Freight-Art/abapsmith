/**
 * Offline fluid-protocol fake for the builtin `fpm` tool (find/outline/app),
 * modeled on test/fluid-classic.test.ts's `dynamicFluidRoute` — an
 * auto-vivifying class store, unfiltered by class name (only two classes are
 * ever deployed here: the shared runtime and ZCL_ZMCP_FLUID_FPM), serving the
 * doc/source/activation/classrun mechanics `dispatch()`/`ensureFluidTool`
 * need. Duplicated rather than imported, per this repo's per-file offline
 * harness convention (see fluid-classic.test.ts's own header).
 *
 * Adapted to `test/fpm-tools.test.ts`'s `RecordingClient`, whose `respond`
 * callback returns a `HttpClientResponse` directly rather than composing
 * `Route`s with `??` — so `fpmFluidRoute` still returns `undefined` for
 * anything it doesn't recognize, and callers fall back to their own base
 * route (session/discovery/ato) the same way `fluid-classic.test.ts` does.
 */
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { FLUID_PACKAGE } from "../../src/adt/fluid/package.js";

export type FpmRoute = (o: HttpClientOptions) => HttpClientResponse | undefined;

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };

export const LOCK_XML = (handle = "H1"): string =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

const CHECKRUN_CLEAN =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

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

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

function nameFromClassUrl(url: string): string | undefined {
  const prefix = "/sap/bc/adt/oo/classes/";
  if (!url.startsWith(prefix)) return undefined;
  const rest = url.slice(prefix.length);
  if (rest.endsWith("/source/main")) return rest.slice(0, -"/source/main".length).toUpperCase();
  if (rest.includes("/")) return undefined;
  return rest.toUpperCase();
}

/** Auto-vivifying class store — see test/fluid-classic.test.ts's copy of this for the full rationale. */
export function fpmFluidRoute(opts: { transcript: () => string }): { route: FpmRoute; store: Map<string, ObjState> } {
  const store = new Map<string, ObjState>();
  const at = (name: string): ObjState => {
    let st = store.get(name);
    if (!st) {
      st = { exists: false, packageName: "$TMP", active: false };
      store.set(name, st);
    }
    return st;
  };

  const route: FpmRoute = (o: HttpClientOptions) => {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const r: Recorded = { method, url: o.url, qs, body: o.body };

    if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (r.url === PACKAGES && r.method === "POST") return resp(200, "", OK_TEXT);

    if (r.url === CLS_COLLECTION && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: FLUID_PACKAGE, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (r.url === "/sap/bc/adt/activation" && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const st = store.get(name);
      if (st) st.active = true;
      return resp(200, "", OK_TEXT);
    }

    if (r.url.startsWith(CLASSRUN_BASE) && r.method === "POST") {
      return resp(200, opts.transcript(), OK_TEXT);
    }

    // classifyOne() syntax-checks an already-active, content-matching object
    // as its last gate before declaring it "present" — read-only, not a mutation.
    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") {
      return resp(200, CHECKRUN_CLEAN, OK_XML);
    }

    const name = nameFromClassUrl(r.url);
    if (name !== undefined) {
      const st = at(name);
      const isSrc = r.url.endsWith("/source/main");
      if (!isSrc && r.method === "GET" && !r.qs._action) {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (isSrc && r.method === "GET") {
        if (!st.exists || st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (!isSrc && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (!isSrc && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (isSrc && r.method === "PUT") {
        st.source = r.body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };

  return { route, store };
}

function frameLine(name: string, payload: unknown): string {
  return `ZMCP-H>${name} ${JSON.stringify(payload)}`;
}

/**
 * Builds a fluid console transcript for the `fpm` tool: one `OUT` frame per
 * element of `outs` (array-output actions `find`/`app` pass one element per
 * row/node; object-output `outline` passes exactly one element).
 */
export function fpmTranscript(opts: { ver: string; action: string; outs?: readonly unknown[] }): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: "fpm", ver: opts.ver, action: opts.action, contract: "1.0" }));
  for (const v of opts.outs ?? []) lines.push(frameLine("OUT", v));
  lines.push(frameLine("END", { rc: 0, outBytes: 0, truncated: false, ms: 1 }));
  return lines.join("\n") + "\n";
}

/** A transcript reporting `truncated: true` on its END frame — dispatch's own outputComplete signal. */
export function fpmTruncatedTranscript(opts: { ver: string; action: string; outs: readonly unknown[] }): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: "fpm", ver: opts.ver, action: opts.action, contract: "1.0" }));
  for (const v of opts.outs) lines.push(frameLine("OUT", v));
  lines.push(frameLine("END", { rc: 0, outBytes: 0, truncated: true, ms: 1 }));
  return lines.join("\n") + "\n";
}

/** A transcript reporting one ERR frame and END rc=1 — outline's not-found case. */
export function fpmErrTranscript(opts: {
  ver: string;
  action: string;
  kind: "subrc" | "exception" | "message";
  step: string;
  text: string;
}): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: "fpm", ver: opts.ver, action: opts.action, contract: "1.0" }));
  lines.push(frameLine("ERR", { kind: opts.kind, step: opts.step, text: opts.text }));
  lines.push(frameLine("END", { rc: 1, outBytes: 0, truncated: false, ms: 1 }));
  return lines.join("\n") + "\n";
}
