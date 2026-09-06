/**
 * `ensureHelperPackage` — offline, same fake-`HttpClient` harness as
 * `test/write-package.test.ts`: a real `AbapConnection` and the real
 * `authorizeMutation`/`createPackage` drive a fake socket, so the request
 * bytes asserted below are what abapsmith would actually put on the wire.
 * `POST /sap/bc/adt/packages` itself is INVENTED (see that file's header) —
 * never captured from a live system.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import {
  HELPER_PACKAGE,
  HELPER_PACKAGE_DESCRIPTION,
  ensureHelperPackage,
} from "../src/adt/helper-package.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const PKG_URI = "/sap/bc/adt/packages/%24zmcp_helpers";
const PACKAGES = "/sap/bc/adt/packages";

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${HELPER_PACKAGE} does not exist</message><properties/></exc:exception>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  /** Every POST to the package collection — the thing a refusal must never make. */
  get creates(): Recorded[] {
    return this.calls.filter((c) => c.method === "POST" && c.url === PACKAGES);
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** Absent (404 on the package URI); the create POST succeeds. */
const absentRoute: Route = (r) => {
  if (r.url === PKG_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
  // INVENTED RESPONSE — see file header. Modelled on PROG/CLAS creates.
  if (r.url === PACKAGES && r.method === "POST") return resp(200, "", {});
  return undefined;
};

/** Already exists (200 on the package URI). */
const existingRoute: Route = (r) => {
  if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(HELPER_PACKAGE), OK_XML);
  if (r.url === PACKAGES && r.method === "POST") return resp(200, "", {});
  return undefined;
};

/** Absent, but the create POST itself 500s — a non-safety failure, unrecognised by any rule in translateAdtError. */
const createFailsRoute: Route = (r) => {
  if (r.url === PKG_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
  if (r.url === PACKAGES && r.method === "POST") return resp(500, "<x/>", OK_XML);
  return undefined;
};

// The create's superpackage is $TMP (ensureHelperPackage passes packageName:
// "$TMP"), so ABAP_ALLOW_PACKAGES must permit $TMP — "*" does, src/safety.ts
// ~line 1538. The default name-prefix rule (Z/Y only) also refuses the
// "$"-named object itself unless widened — same file, ~line 1565 — so an
// operator wiring up automatic helper-package creation must set
// ABAP_ALLOW_NAME_PREFIXES accordingly.
const ALLOW_GATE = new SafetyGate({
  readOnly: false,
  allowPackages: ["*"],
  allowNamePrefixes: ["*"],
});
const REFUSING_GATE = new SafetyGate({ readOnly: false, allowPackages: ["SOME_OTHER_PACKAGE"] });

// Package allowlist wide open so ONLY the name-prefix rule can refuse this —
// isolates it from REFUSING_GATE's package-allowlist case.
const NAME_PREFIX_REFUSING_GATE = new SafetyGate({
  readOnly: false,
  allowPackages: ["*"],
  allowNamePrefixes: ["Z", "Y"],
});

describe("HELPER_PACKAGE constant", () => {
  it("is $ZMCP_HELPERS, a local ($-prefixed, non-transportable) name", () => {
    expect(HELPER_PACKAGE).toBe("$ZMCP_HELPERS");
    expect(HELPER_PACKAGE.startsWith("$")).toBe(true);
  });

  it("has a CTEXT-fitting description (SCOMPKDTLN-CTEXT is CHAR60)", () => {
    expect(HELPER_PACKAGE_DESCRIPTION.length).toBeLessThanOrEqual(60);
    expect(HELPER_PACKAGE_DESCRIPTION.length).toBeGreaterThan(0);
  });
});

describe("ensureHelperPackage", () => {
  it("returns created:false and issues NO create POST when the package already exists", async () => {
    const { conn, adt } = await connected(existingRoute);

    const res = await ensureHelperPackage(conn, ALLOW_GATE);

    expect(res).toEqual({ package: HELPER_PACKAGE, created: false });
    // The already-exists path never ran createPackage, so there is no
    // PackageCreateResult to read a superPackage off — must not fabricate one.
    expect(res.superPackage).toBeUndefined();
    expect(adt.creates).toHaveLength(0);
  });

  it("creates $ZMCP_HELPERS as a sub-package of $TMP and returns superPackage:$TMP when absent", async () => {
    const { conn, adt } = await connected(absentRoute);

    const res = await ensureHelperPackage(conn, ALLOW_GATE);

    expect(res).toEqual({ package: HELPER_PACKAGE, created: true, superPackage: "$TMP" });
    expect(adt.creates).toHaveLength(1);

    const create = adt.creates[0]!;
    expect(create.body).toContain(`adtcore:name="${HELPER_PACKAGE}"`);
    // $TMP as the super package — verified live on 2026-09-05 (see
    // src/adt/helper-package.ts); a root package (no <pak:superPackage> name)
    // is the bug this guards against.
    expect(create.body).toContain('<pak:superPackage adtcore:name="$TMP"/>');
    expect(create.body).toContain('pak:name="LOCAL"');
    // A LOCAL create carries no corrNr — nothing to transport.
    expect(create.qs.corrNr).toBeUndefined();
  });

  it("a refused create throws, names $ZMCP_HELPERS and the no-$TMP-fallback rule, and sends nothing naming $TMP", async () => {
    const { conn, adt } = await connected(absentRoute);

    const err = await catchErr(ensureHelperPackage(conn, REFUSING_GATE));

    expect(err.code).toBe("SAFETY_DENIED");
    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toContain(HELPER_PACKAGE);
    expect(text.toLowerCase()).toContain("does not fall back to $tmp");
    // The allowlist question for this create is $TMP (the super package),
    // not "a root package" — that was the pre-fix (wrong) shape.
    expect(text).toContain("$TMP, its super package");
    expect(text).not.toContain("permit a root package");

    // No create POST at all (the gate refused before the wire), and nothing
    // recorded ever names $TMP.
    expect(adt.creates).toHaveLength(0);
    for (const c of adt.calls) {
      expect(c.url).not.toContain("$TMP");
      expect(c.url).not.toContain("$tmp");
      expect(JSON.stringify(c.qs)).not.toContain("$TMP");
      expect(c.body ?? "").not.toContain("$TMP");
    }
  });

  it("a name-prefix refusal (package allowlist wide open) throws SAFETY_DENIED and its hint names ABAP_ALLOW_NAME_PREFIXES, ABAP_ALLOW_PACKAGES as a separate rule, and $, and still has no $TMP fallback", async () => {
    const { conn, adt } = await connected(absentRoute);

    const err = await catchErr(ensureHelperPackage(conn, NAME_PREFIX_REFUSING_GATE));

    expect(err.code).toBe("SAFETY_DENIED");
    const hint = err.hint ?? "";
    expect(hint).toContain("ABAP_ALLOW_NAME_PREFIXES");
    expect(hint).toContain("ABAP_ALLOW_PACKAGES");
    expect(hint).toContain("$");
    expect(hint.toLowerCase()).toContain("does not fall back to $tmp");
    // Corrected wording: the package clause names $TMP, not "a root package".
    expect(hint).toContain("$TMP, its super package");
    expect(hint).not.toContain("permit a root package");

    // Gate refuses before the wire — no create POST at all.
    expect(adt.creates).toHaveLength(0);
  });

  it("a non-safety failure (create POST 500s) keeps the generic no-$TMP-fallback hint but not the name-prefix/package sentence", async () => {
    const { conn, adt } = await connected(createFailsRoute);

    const err = await catchErr(ensureHelperPackage(conn, ALLOW_GATE));

    expect(err.code).not.toBe("SAFETY_DENIED");
    const hint = err.hint ?? "";
    expect(hint.toLowerCase()).toContain("does not fall back to $tmp");
    expect(hint).not.toContain("ABAP_ALLOW_NAME_PREFIXES");
    expect(hint).not.toContain("ABAP_ALLOW_PACKAGES");

    // The create POST WAS attempted here (unlike the gate-refusal cases above) — it just failed on the wire.
    expect(adt.creates).toHaveLength(1);
  });
});

// No test in this repo reads a source .ts file's text to check imports vs.
// hardcoding (checked: no existing idiom for it) — skipped rather than
// inventing a new one. img-write-bridge.ts does not name HELPER_PACKAGE in
// code today (no deploy call yet, see its header comment); when a later
// increment wires the deploy, that call site is what should import the
// constant.
