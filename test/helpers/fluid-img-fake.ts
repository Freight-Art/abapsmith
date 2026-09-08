/**
 * Shared fake-ADT plumbing for the fluid `img` tool's `preview` action, used
 * by img-write.test.ts and img-edit-tool.test.ts. Two things live here:
 *
 * - `imgProbeConsole`: wraps a plain `IMGW>`/`ZMCP-DDIC-ERR>` transcript (the
 *   same fixture text `parseImgWriteTranscript` has always consumed) into
 *   the fluid console frame grammar `src/adt/fluid/protocol.ts` expects —
 *   one `OUT` frame per line, bracketed by `BEGIN`/`END`. `imgManifest`'s
 *   `preview` action declares an array-of-string output, so `dispatch()`
 *   hands back `res.result` as exactly that array of OUT payloads, and
 *   `runImgProbe` (img-write.ts) re-joins them with `\n` before parsing —
 *   hence one line per frame, not one frame holding the whole array.
 *
 * - `dynamicImgFluidRoute`: auto-vivifying class store for the two class
 *   shapes the fluid img probe ever deploys — the fixed body class
 *   (`imgManifest.entry`) and the content-hash invoker `dispatch()` computes
 *   at runtime (`ZCL_ZMCP_I_[0-9A-F]{8}`, src/adt/fluid/invoke.ts). Same
 *   idiom as test/fluid-dispatch.test.ts's `dynamicFluidRoute`, generalized
 *   with `activationError`/`classrunOverride` hooks so the same store can
 *   also stand in for an activation-refusal or below-activation classrun
 *   failure. Returns `undefined` for anything it doesn't recognize (package
 *   existence, login, other bridge classes), so it composes as a fallback
 *   under each test file's own `baseRoute`.
 */
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { imgManifest, imgSources } from "../../src/adt/fluid/builtin/img.js";
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

/** The only two class shapes the fluid img probe ever deploys: the fixed body class, or a content-hash invoker (src/adt/fluid/invoke.ts). */
export function isImgFluidClass(name: string): boolean {
  return name === imgManifest.entry || /^ZCL_ZMCP_I_[0-9A-F]{8}$/.test(name);
}

export const imgManifestVersion: string = manifestVersion(imgManifest, imgSources);

/** One `OUT` frame per line of `raw`, bracketed by BEGIN (id: "img", action: "preview") and END. */
export function imgProbeConsole(
  raw: string,
  opts: { ver?: string; rc?: number; truncated?: boolean } = {},
): string {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const frame = (name: string, payload: unknown) => `ZMCP-H>${name} ${JSON.stringify(payload)}`;
  const out = [
    frame("BEGIN", { id: "img", action: "preview", ver: opts.ver ?? imgManifestVersion, contract: imgManifest.contract }),
    ...lines.map((l) => frame("OUT", l)),
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

export interface ImgFluidRouteOptions {
  /** classrun output for the invoker's execution — normally built with `imgProbeConsole`. */
  transcript: () => string;
  /** Bridge deploy package name embedded in class-create bodies and classDocXml's packageRef. */
  packageName: string;
  /** When set, activation of a class satisfying `matches` answers with this XML instead of a bare success — same shape as img-write.test.ts's bridgeActivationRefused/bridgeActivationDuplicateDeclaration. */
  activationError?: { matches: (className: string) => boolean; xml: (className: string) => string };
  /** When set, classrun for any fluid img class is answered by this instead of `transcript()` — for a below-activation scaffold failure (e.g. classrun itself 500s). */
  classrunOverride?: (o: HttpClientOptions) => HttpClientResponse;
}

export function dynamicImgFluidRoute(
  opts: ImgFluidRouteOptions,
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
      if (!isImgFluidClass(name)) return undefined;
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: opts.packageName, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (o.url === "/sap/bc/adt/activation" && method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(o.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      if (!isImgFluidClass(name)) return undefined;
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
    if (name !== undefined && isImgFluidClass(name)) {
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
