/**
 * `$`-named local objects (`$TMP`, the default write package, addressed as an
 * `object` argument rather than `package`). Issue: `NAME_RE` admitted neither
 * `$` character class, so `parseObjectRef("$TMP")` threw `BAD_INPUT` before
 * SAP was ever contacted — abapsmith's own default write package could not be
 * addressed as an object.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { parseObjectRef, resolveObject } from "../src/adt/resolve.js";
import { buildUri, specForType, specFromUri } from "../src/adt/types.js";
import { isAbapError } from "../src/adt/errors.js";
import { resolveWriteTarget } from "../src/adt/write.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

describe("parseObjectRef — $-local names", () => {
  it("takes a bare $TMP name and guesses nothing it cannot justify", () => {
    const r = parseObjectRef("$TMP");
    expect(r.name).toBe("$TMP");
    expect(r.spec).toBeUndefined();
    expect(r.via).toBe("unknown");
  });

  it("takes a bare $MCP_DELPROBE1 name", () => {
    expect(parseObjectRef("$MCP_DELPROBE1").name).toBe("$MCP_DELPROBE1");
  });

  it("uppercases a lowercase $ name", () => {
    expect(parseObjectRef("$tmp").name).toBe("$TMP");
  });

  it("accepts an explicit DEVC/K type-code prefix", () => {
    const r = parseObjectRef("DEVC/K $TMP");
    expect(r.name).toBe("$TMP");
    expect(r.spec?.type).toBe("DEVC/K");
    expect(r.via).toBe("typecode");
  });

  it("accepts the 'package' keyword prefix", () => {
    // DEVC/K declares "package" among its keywords (src/adt/types.ts).
    const r = parseObjectRef("package $TMP");
    expect(r.name).toBe("$TMP");
    expect(r.spec?.type).toBe("DEVC/K");
    expect(r.via).toBe("keyword");
  });

  it("agrees with the abap:// resource form, which never went through NAME_RE", () => {
    // The abap:// branch (resolve.ts) captures the name with an unrestricted
    // regex and never reaches NAME_RE, so it already accepted "$TMP" before
    // this fix. The bare-name form must now say the same thing.
    expect(parseObjectRef("abap://A4H/DEVC/$TMP").name).toBe("$TMP");
    expect(parseObjectRef("$TMP").name).toBe("$TMP");
  });
});

describe("resolveObject — $TMP resolves to the real package URI", () => {
  const connWith = (hits: unknown[]) =>
    ({
      cfg: { sid: "A4H" },
      adt: { searchObject: async () => hits },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("matches the live-captured wire URI for $TMP, and survives the encode/decode round trip", async () => {
    // Expected URI is read off real wire bytes, not typed by hand: see
    // test/fixtures/live-captured/073-p2-packageref-prog.xml (see INDEX.md
    // for provenance) — a live A4H capture of a PROG/P's packageRef.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
    const xml = readFileSync(join(dir, "073-p2-packageref-prog.xml"), "utf8");
    const packageRef = /<adtcore:packageRef\b[^>]*\/>/.exec(xml)?.[0];
    expect(packageRef).toBeDefined();
    const capturedUri = /adtcore:uri="([^"]+)"/.exec(packageRef!)?.[1];
    const capturedName = /adtcore:name="([^"]+)"/.exec(packageRef!)?.[1];
    expect(capturedUri).toBe("/sap/bc/adt/packages/%24tmp");
    expect(capturedName).toBe("$TMP");

    const r = await resolveObject(connWith([]), capturedName!, {
      type: "DEVC/K",
      trustHint: true,
    });
    expect(r.uri).toBe(capturedUri);

    // "$" survives encodeURIComponent (%24) and decodeURIComponent, matching
    // the server's own spelling.
    const roundTripped = specFromUri(buildUri(specForType("DEVC/K")!, "$TMP"));
    expect(roundTripped?.name).toBe("$TMP");
    expect(roundTripped?.spec.type).toBe("DEVC/K");
  });
});

describe("parseObjectRef — $ boundary rejections (pin the widening, do not prove the fix)", () => {
  const rejects = (input: string) => {
    try {
      parseObjectRef(input);
      expect.unreachable(`expected ${JSON.stringify(input)} to throw`);
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
    }
  };

  it("rejects a bare $ with nothing after it", () => {
    rejects("$");
  });

  it("rejects a digit right after the $ sigil", () => {
    rejects("$1FOO");
  });

  it("rejects $ that is not the leading character", () => {
    rejects("Z$FOO");
  });

  it("rejects a namespace segment after the $ sigil", () => {
    rejects("$/DMO/FOO");
  });

  it("rejects a slash inside a $-local name", () => {
    rejects("$TMP/SUB");
  });

  it("still rejects genuinely unparseable input", () => {
    rejects("!!!");
  });
});

/**
 * The write half of the `$`-named-object gap: `src/adt/write.ts` kept its own `NAME_RE`
 * (`/^[A-Z_/][A-Z0-9_/]*$/`, no `$`) applied to `resolveWriteTarget`'s
 * already-parsed name, so `abap_write` refused every `$`-named target even
 * though `parseObjectRef` above had already accepted it. $TMP and $MCP_* are
 * packages (DEVC/K) — the natural type to prove this against, since a
 * package is creatable/deletable and its own default write package.
 */
describe("resolveWriteTarget — $-local names on the write path", () => {
  const PACKAGE_URI = "/sap/bc/adt/packages/%24tmp";

  const NOT_FOUND_XML = (name: string) =>
    `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
    `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
    `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

  const resp = (
    status: number,
    body = "",
    headers: Record<string, unknown> = {},
  ): HttpClientResponse =>
    ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

  const OK_XML = { "content-type": "application/xml" };
  const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

  type Route = (method: string, url: string) => HttpClientResponse | undefined;

  class FakeAdt implements HttpClient {
    constructor(private readonly route: Route) {}
    async request(o: HttpClientOptions): Promise<HttpClientResponse> {
      const method = (o.method ?? "GET").toUpperCase();
      const res = this.route(method, o.url);
      if (!res) throw new Error(`FakeAdt: unrouted request ${method} ${o.url}`);
      return res;
    }
  }

  /** Everything `AbapConnection.connect()` needs before any object is touched. */
  function baseRoute(method: string, url: string): HttpClientResponse | undefined {
    if (url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    return undefined;
  }

  async function connected(route: Route): Promise<AbapConnection> {
    const config: Config = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "DEVELOPER",
      password: "secret",
      sid: "A4H",
      client: "001",
      readOnly: false,
    });
    const conn = new AbapConnection(config, {
      httpClient: new FakeAdt((m, u) => baseRoute(m, u) ?? route(m, u)),
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    return conn;
  }

  it("resolves $TMP to a creatable DEVC/K write target — RED on unmodified master, which throws BAD_INPUT before this GET is ever sent", async () => {
    const conn = await connected((method, url) =>
      method === "GET" && url === PACKAGE_URI ? resp(404, NOT_FOUND_XML("$TMP"), OK_XML) : undefined,
    );

    const target = await resolveWriteTarget(conn, { type: "DEVC/K", name: "$TMP" });

    expect(target.name).toBe("$TMP");
    expect(target.type).toBe("DEVC/K");
    expect(target.uri).toBe(PACKAGE_URI);
    expect(target.exists).toBe(false);
  });

  /**
   * These five never reach write.ts's `NAME_RE` at all — `parseObjectRef`
   * (resolve.ts) refuses them first, on unmodified master exactly as it does
   * today, so they are pins on already-correct behaviour, not proof of the
   * write-path bug above. An `offline` connection is the assertion: nothing
   * here should ever need to reach the wire.
   */
  describe("still rejects the same five $ shapes, offline (regression pins, not red proof)", () => {
    const offline = null as unknown as AbapConnection;

    const rejectsWrite = async (name: string) => {
      const e = await resolveWriteTarget(offline, { type: "DEVC/K", name }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
      expect((e as { message: string }).message).toMatch(
        /Could not extract an ABAP object name from/,
      );
    };

    it.each([
      ["a digit right after the $ sigil", "$1FOO"],
      ["a bare $ with nothing after it", "$"],
      ["$ that is not the leading character", "Z$FOO"],
      ["a namespace segment after the $ sigil", "$/DMO/FOO"],
      ["a slash inside a $-local name", "$TMP/SUB"],
    ])("%s: %s", async (_label, name) => {
      await rejectsWrite(name);
    });
  });
});
