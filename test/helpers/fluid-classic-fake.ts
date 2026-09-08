/**
 * Shared fake HTTP routing for the fluid `classic` tool's ensure/deploy/
 * classrun cycle — the replacement for the old per-operation bridge-class
 * routing the VIEW create/delete suites hand-rolled before the S3 rewire.
 *
 * One {@link classicFake} call routes: the fluid package GET/create, the
 * `ZCL_ZMCP_FLUID_RT`/`ZCL_ZMCP_FLUID_CLASSIC` cold-deploy plumbing and the
 * per-call content-hashed invoker class's own deploy (class collection
 * POST, source GET/PUT, LOCK/UNLOCK, activation) — auto-vivifying object
 * state by name the same way `test/fluid-dispatch.test.ts`'s
 * `dynamicFluidRoute` does, since the invoker name is content-hash derived
 * and can't be known ahead of time — and exactly one classrun POST, which
 * always answers with the same `ZMCP-H>` transcript built from
 * `opts.lines()`.
 *
 * Unlike `dynamicFluidRoute`, a 404 here THROWS `HttpClientException`
 * rather than returning a 404 response object: that is the shape the real
 * transport uses, and the convention every DDIC suite's own hand-rolled
 * `RecordingClient` already follows (see e.g. `test/view-delete.test.ts`,
 * `test/tran-delete.test.ts`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { CLASSIC_TOOL_ID, classicTool } from "../../src/adt/fluid/builtin/classic.js";
import { FLUID_CONTRACT } from "../../src/adt/fluid/manifest.js";
import { FLUID_FRAME_PREFIX } from "../../src/adt/fluid/protocol.js";
import { FLUID_PACKAGE } from "../../src/adt/fluid/package.js";

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PACKAGES = "/sap/bc/adt/packages";
const PKG_URI = `${PACKAGES}/${encodeURIComponent(FLUID_PACKAGE).toLowerCase()}`;
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

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
  opts: { mainVersion?: string; packageName?: string } = {},
): string {
  const main = opts.mainVersion ?? "active";
  const pkg = opts.packageName ?? "$TMP";
  const ver = (v: string) => ` adtcore:version="${v}"`;
  const inc = (type: string, version: string) =>
    `<class:include class:includeType="${type}" ` +
    `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
    `adtcore:name="" adtcore:type="CLAS/I"${ver(version)}/>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC"${ver("active")} ` +
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

export interface ObjState {
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

/** Per-call invoker classes are `ZCL_ZMCP_I_` + 8 hex (`src/adt/fluid/invoke.ts`). */
const INVOKER_RE = /^ZCL_ZMCP_I_[0-9A-F]{8}$/;

const notFound = (o: HttpClientOptions, name: string): never => {
  const r = resp(404, notFoundXml(name), OK_XML);
  throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
};

/**
 * A stateDir isolated to one test file, so the fluid registry cache
 * (`src/adt/fluid/registry.ts`) doesn't leak deploy state across suites
 * that share a process. Created lazily on first `dir()` call.
 */
export function useFluidState(): { dir: () => string } {
  let dir: string | undefined;
  return {
    dir(): string {
      dir ??= mkdtempSync(join(tmpdir(), "abapsmith-fluid-classic-"));
      return dir;
    },
  };
}

/** One `ZMCP-H>` transcript: a BEGIN frame, one OUT frame per line, an END frame. */
export function classicConsole(action: string, lines: readonly string[], truncated = false): string {
  const begin = { id: CLASSIC_TOOL_ID, ver: classicTool.version, action, contract: FLUID_CONTRACT };
  const end = { rc: 0, outBytes: lines.reduce((n, l) => n + l.length, 0), truncated, ms: 1 };
  const rows = [
    `${FLUID_FRAME_PREFIX}BEGIN ${JSON.stringify(begin)}`,
    ...lines.map((line) => `${FLUID_FRAME_PREFIX}OUT ${JSON.stringify(line)}`),
    `${FLUID_FRAME_PREFIX}END ${JSON.stringify(end)}`,
  ];
  return rows.join("\n") + "\n";
}

export interface ClassicFakeOptions {
  /** The fluid action under test, e.g. "delete_view" — echoed into the transcript's BEGIN frame. */
  readonly action: string;
  /** Lazy so a test can change what the classrun answers between calls (e.g. the undo leg). */
  readonly lines: () => readonly string[];
  readonly truncated?: boolean;
}

export interface ClassicFake {
  readonly route: (o: HttpClientOptions) => HttpClientResponse | undefined;
  readonly store: Map<string, ObjState>;
  /** Class names that exist in the fake, in first-seen order. */
  deployed(): readonly string[];
  /** The one `ZCL_ZMCP_I_<hex>` invoker class seen so far, if any. */
  invoker(): string | undefined;
  sourceOf(name: string): string | undefined;
}

export function classicFake(opts: ClassicFakeOptions): ClassicFake {
  const store = new Map<string, ObjState>();
  const at = (name: string): ObjState => {
    let st = store.get(name);
    if (!st) {
      st = { exists: false, packageName: "$TMP", active: false };
      store.set(name, st);
    }
    return st;
  };

  const route = (o: HttpClientOptions): HttpClientResponse | undefined => {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const url = o.url;
    const body = o.body;

    if (url === PKG_URI && method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (url === PACKAGES && method === "POST") return resp(200, "", OK_TEXT);

    if (url === CLS_COLLECTION && method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: FLUID_PACKAGE, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (url === "/sap/bc/adt/activation" && method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const st = store.get(name);
      if (st) st.active = true;
      return resp(200, "", OK_TEXT);
    }

    if (url.startsWith(CLASSRUN_BASE) && method === "POST") {
      return resp(200, classicConsole(opts.action, opts.lines(), opts.truncated), OK_TEXT);
    }

    const name = nameFromClassUrl(url);
    if (name !== undefined) {
      const st = at(name);
      const isSrc = url.endsWith("/source/main");
      if (!isSrc && method === "GET" && !qs._action) {
        if (!st.exists) return notFound(o, name);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (isSrc && method === "GET") {
        if (!st.exists || st.source === undefined) return notFound(o, name);
        return resp(200, st.source, OK_TEXT);
      }
      if (!isSrc && qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (!isSrc && qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (isSrc && method === "PUT") {
        st.source = body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };

  return {
    route,
    store,
    deployed(): readonly string[] {
      return [...store.entries()].filter(([, st]) => st.exists).map(([n]) => n);
    },
    invoker(): string | undefined {
      return [...store.keys()].find((n) => INVOKER_RE.test(n));
    },
    sourceOf(name: string): string | undefined {
      return store.get(name.toUpperCase())?.source;
    },
  };
}
