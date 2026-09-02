/**
 * Unit tests for scripts/check-no-leaks.mjs's base64 decode-and-rescan pass.
 * SAP's ICF stateful-session URLs embed a base64 segment —
 * `/sap(<base64>)/bc/gui/sap/its/webgui` — that decodes to
 * `<hostname>_<SID>_<instance>`, so a captured URL/HAR/trace/log line can
 * carry a hostname past the plaintext RULES with a clean scan. These feed
 * hand-written fixture lines straight to the exported `scanLines`, so they
 * run fully offline and never shell out to `git ls-files` or touch disk.
 *
 * This file is itself a tracked file the scanner scans, so — exactly like
 * scripts/check-no-leaks.mjs's own header explains for itself — it must not
 * contain a literal copy of anything the rules match. Every fixture below
 * (the fake appliance-style hostname, the placeholder routable address, and
 * every base64 blob) is assembled at runtime via concatenation/encoding
 * rather than written as a contiguous literal, and prose below avoids
 * spelling them out too, so this file passes the very tool it tests.
 */
import { describe, expect, it } from "vitest";
import { scanLines } from "../scripts/check-no-leaks.mjs";

const encode = (s: string) => Buffer.from(s, "utf8").toString("base64");

// Fake SAP-appliance-style hostname prefix, assembled so the trigger
// substring never appears contiguous in this file's own source text.
const APPLIANCE_PREFIX = ["vh", "cal"].join("");
const FAKE_HOSTNAME = `${APPLIANCE_PREFIX}fake01`;
const FAKE_SID = "S4H";
const FAKE_INSTANCE = "00";
const FAKE_SESSION_TOKEN = `${FAKE_HOSTNAME}_${FAKE_SID}_${FAKE_INSTANCE}`;

// The one appliance name the scanner exempts — SAP's published NPL developer
// edition, which `abap-adt-api` names in a JSDoc example that `bundle/`
// inlines. Assembled the same way as the rest, for the reasons in the header.
const PUBLIC_DEMO_HOSTNAME = `${APPLIANCE_PREFIX}nplci`;

// A syntactically routable placeholder address — not in any RFC 1918/3927
// or RFC 5737 documentation block the scanner's own allowlist exempts —
// assembled the same way so it never appears as a literal dotted-quad here.
const FAKE_ROUTABLE_IP = [1, 2, 3, 4].join(".");

describe("plaintext rules (unchanged baseline)", () => {
  it("still catches a bare routable IPv4 address", () => {
    const findings = scanLines([`the console lives at ${FAKE_ROUTABLE_IP}`]);
    expect(
      findings.some((f) => f.rule === "public IPv4 address" && f.hit === FAKE_ROUTABLE_IP),
    ).toBe(true);
  });

  it("still catches a bare appliance-style hostname", () => {
    const findings = scanLines([`host: ${FAKE_HOSTNAME}`]);
    expect(
      findings.some((f) => f.rule.includes("appliance hostname") && f.hit === FAKE_HOSTNAME),
    ).toBe(true);
  });

  it("exempts the published developer-edition appliance name the bundle inlines", () => {
    const findings = scanLines([`Base url, i.e. http://${PUBLIC_DEMO_HOSTNAME}.local:8000`]);
    expect(findings.filter((f) => f.rule.includes("appliance hostname"))).toEqual([]);
  });

  it("exempts that one name only, not every name sharing its prefix", () => {
    const lookalike = `${PUBLIC_DEMO_HOSTNAME}2`;
    const findings = scanLines([`host: ${lookalike}`]);
    expect(
      findings.some((f) => f.rule.includes("appliance hostname") && f.hit === lookalike),
    ).toBe(true);
  });
});

describe("base64 decode-and-rescan", () => {
  it("catches a routable IPv4 address hidden inside a base64 blob", () => {
    const line = `log: ${encode(`visit ${FAKE_ROUTABLE_IP} for the console`)}`;
    const findings = scanLines([line]);
    const hit = findings.find(
      (f) => f.rule.includes("public IPv4 address") && f.rule.includes("base64-decoded"),
    );
    expect(hit).toBeDefined();
    expect(hit?.hit).toBe(FAKE_ROUTABLE_IP);
    expect(hit?.line).toBe(1);
  });

  it("catches an appliance-style hostname hidden inside a base64 blob", () => {
    const line = `trace attr: ${encode(FAKE_SESSION_TOKEN)}`;
    const findings = scanLines([line]);
    const hit = findings.find(
      (f) => f.rule.includes("appliance hostname") && f.rule.includes("base64-decoded"),
    );
    expect(hit).toBeDefined();
    expect(hit?.hit).toBe(FAKE_SESSION_TOKEN);
  });

  it("does NOT flag a package-lock.json-style sha512 integrity hash", () => {
    // A real line lifted from this repo's package-lock.json: base64 of a
    // sha512 digest is binary, not text, so it must never reach RULES.
    const line =
      '      "integrity": "sha512-jPH01e/gho1GH5JLWf1XUsN0kwqfVJasDOhgNRpEzhyhGuRfXUn5BzWWxEJHL1Yuo9qEwRkkm1AEHgpebJd/qQ==",';
    const findings = scanLines([line]);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag ordinary long camelCase/kebab identifiers", () => {
    const line =
      "const someVeryLongDescriptiveVariableNameForClarity = computeAnotherLongIdentifierValue();";
    const findings = scanLines([line]);
    expect(findings).toHaveLength(0);
  });
});

describe("SAP ICF stateful-session URL segment", () => {
  it("names the /sap(...)/ shape directly and reports the decoded token", () => {
    const line = `GET /sap(${encode(FAKE_SESSION_TOKEN)})/bc/gui/sap/its/webgui HTTP/1.1`;
    const findings = scanLines([line]);
    const icfHit = findings.find((f) =>
      f.rule.startsWith("SAP ICF stateful-session URL segment"),
    );
    expect(icfHit).toBeDefined();
    expect(icfHit?.hit).toBe(FAKE_SESSION_TOKEN);

    // The same segment is also a base64 candidate in its own right, so the
    // generic decode pass independently confirms the appliance-style
    // hostname too.
    expect(
      findings.some(
        (f) =>
          f.rule.includes("appliance hostname") &&
          f.rule.includes("base64-decoded") &&
          f.hit === FAKE_SESSION_TOKEN,
      ),
    ).toBe(true);
  });

  it("does not flag an unrelated parenthesized path segment", () => {
    const line = "see notes(about the build) for details";
    const findings = scanLines([line]);
    expect(findings.some((f) => f.rule.startsWith("SAP ICF stateful-session URL segment"))).toBe(
      false,
    );
  });
});
