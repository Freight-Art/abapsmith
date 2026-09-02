#!/usr/bin/env node
// Pre-publication leak guard.
//
// This repo's docs and captured fixtures are full of real wire traffic from a
// sandbox appliance, so it is easy to commit its address by accident. This
// script fails the build if a tracked file names a routable host.
//
// It enumerates files via `git ls-files`, so anything gitignored — notably
// `.env`, which holds the only real credentials — is never opened at all.
//
// Deliberately, this file contains no copy of the value it is guarding: the
// rules below match the *class* (any public IPv4, SAP's `vhcal*` appliance
// naming prefix), so the guard cannot itself become the leak.
//
// Run: node scripts/check-no-leaks.mjs   (also `npm run check:leaks`)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Octets never carry leading zeros in a real dotted-quad, which is what keeps
// version strings like `HDB 2.00.044.0` from being reported as addresses.
const OCTET = "(?:0|[1-9]\\d{0,2})";
const IPV4 = new RegExp(`\\b${OCTET}(?:\\.${OCTET}){3}\\b`, "g");

// Non-routable or reserved-for-documentation space is fine to commit.
const isAllowedIp = (ip) => {
  const o = ip.split(".").map(Number);
  if (o.some((n) => n > 255)) return true; // not an address at all
  if (o[0] === 0 || o[0] === 127) return true; // this-host / loopback
  if (o[0] === 10) return true; // RFC 1918
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // RFC 1918
  if (o[0] === 192 && o[1] === 168) return true; // RFC 1918
  if (o[0] === 169 && o[1] === 254) return true; // RFC 3927 link-local
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true; // RFC 5737 TEST-NET-1
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true; // TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true; // TEST-NET-3
  return false;
};

const RULES = [
  {
    name: "public IPv4 address",
    find: (line) => [...line.matchAll(IPV4)].map((m) => m[0]).filter((ip) => !isAllowedIp(ip)),
  },
  {
    name: "SAP appliance hostname (vhcal* naming)",
    find: (line) => [...line.matchAll(/\bvhcal[a-z0-9_]*/gi)].map((m) => m[0]),
  },
  {
    name: "internal SAP hostname",
    // `people.wdf.sap.corp` is exempt: SAP's own ADT feed hardcodes it as the
    // author URI, so it appears verbatim in every SAP system's output. It
    // describes SAP's infrastructure, not ours, and scrubbing it from captured
    // XML would corrupt the evidence without concealing anything.
    find: (line) =>
      [...line.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.sap\.corp\b/gi)]
        .map((m) => m[0])
        .filter((h) => h.toLowerCase() !== "people.wdf.sap.corp"),
  },
];

// --- base64 decode-and-rescan ----------------------------------------------
//
// SAP's ICF stateful-session URLs embed a base64 segment —
// `/sap(<base64>)/bc/gui/sap/its/webgui` — that decodes to
// `<hostname>_<SID>_<instance>`. On the page it is an opaque token, so a
// captured URL, HAR, Playwright trace or pasted log can carry a hostname
// past the plaintext RULES above with a clean scan. This section is
// strictly additive: it never touches RULES above, it only finds more
// text to run them against.
//
// Candidate runs use the standard and URL-safe base64 alphabets, 16+ chars
// (the chosen length floor — short runs are indistinguishable
// from ordinary identifiers). Almost every long alphanumeric identifier in
// the tree is technically "valid base64" by alphabet alone, so the real
// filter is what happens after decoding: discard anything that is not
// mostly printable text. That is also what keeps this quiet on
// package-lock.json's sha512-* integrity hashes — those decode to random
// binary, not text, so they never reach the RULES pass at all.
const BASE64_STD = /[A-Za-z0-9+/]{16,}={0,2}/g;
const BASE64_URLSAFE = /[A-Za-z0-9_-]{16,}/g;

// Ratio, not an exact match: a handful of stray non-printable bytes
// shouldn't sink an otherwise-clear hostname_SID_instance decode, but mostly
// binary output (a hash, an image chunk, ...) must never reach RULES.
const PRINTABLE_BYTE = /[\t\n\x20-\x7e]/;
const isMostlyPrintable = (buf) => {
  if (buf.length < 6) return false; // too short to carry a meaningful token
  let printable = 0;
  for (const byte of buf) if (PRINTABLE_BYTE.test(String.fromCharCode(byte))) printable++;
  return printable / buf.length >= 0.85;
};

// Returns the decoded text, or null if this candidate isn't real base64 of
// mostly-printable content (i.e. it's noise: an identifier, a hash, a
// binary blob) and should be discarded rather than fed to RULES.
const decodeBase64Candidate = (token, encoding) => {
  let buf;
  try {
    buf = Buffer.from(token, encoding);
  } catch {
    return null;
  }
  if (!isMostlyPrintable(buf)) return null;
  return buf.toString("latin1");
};

// Runs the *same* RULES array against decoded base64 text, so this path and
// the plaintext path above cannot drift apart. Only the matched plaintext
// is reported (never the whole decoded blob), against the encoded line.
const findBase64Findings = (line) => {
  const results = [];
  const seen = new Set(); // dedupe: std/url-safe alphabets both match plain alnum runs
  const candidates = [
    ...[...line.matchAll(BASE64_STD)].map((m) => ({ token: m[0], encoding: "base64" })),
    ...[...line.matchAll(BASE64_URLSAFE)].map((m) => ({ token: m[0], encoding: "base64url" })),
  ];
  for (const { token, encoding } of candidates) {
    const decoded = decodeBase64Candidate(token, encoding);
    if (decoded == null) continue;
    for (const rule of RULES) {
      for (const hit of rule.find(decoded)) {
        const key = `${rule.name}\0${hit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ rule: `${rule.name} (base64-decoded)`, hit });
      }
    }
  }
  return results;
};

// The ICF stateful-session shape is specific and self-identifying enough to
// name directly, independent of whether its decoded content happens to also
// match one of the plaintext RULES above — a decoded `myhost_S4H_00` names
// a real host and SID even though "myhost" alone matches no existing rule.
const ICF_SESSION_SEGMENT = /\/sap\(([A-Za-z0-9+/_=-]{8,})\)\//g;

const findIcfSessionFindings = (line) => {
  const results = [];
  for (const m of line.matchAll(ICF_SESSION_SEGMENT)) {
    const token = m[1];
    const encoding = /[+/]/.test(token) ? "base64" : "base64url";
    const decoded = decodeBase64Candidate(token, encoding);
    if (decoded == null) continue;
    results.push({
      rule: "SAP ICF stateful-session URL segment (decodes to hostname_SID_instance)",
      hit: decoded,
    });
  }
  return results;
};

const BINARY = /\.(png|jpe?g|gif|pdf|zip|gz|ico|woff2?)$/i;

// Scans one file's lines against every rule — the plaintext RULES, plus the
// additive base64-decode and ICF-shape passes above. Exported so tests can
// drive it directly without shelling out to `git ls-files` or touching disk.
export function scanLines(lines) {
  const findings = [];
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      for (const hit of rule.find(lines[i])) {
        findings.push({ line: i + 1, rule: rule.name, hit });
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (const f of findBase64Findings(lines[i])) findings.push({ line: i + 1, ...f });
    for (const f of findIcfSessionFindings(lines[i])) findings.push({ line: i + 1, ...f });
  }
  return findings;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter((f) => f && !BINARY.test(f) && f !== "scripts/check-no-leaks.mjs");

  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable or genuinely binary; nothing to scan
    }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (const f of scanLines(lines)) findings.push({ file, ...f });
  }

  if (findings.length === 0) {
    console.log(`check-no-leaks: clean (${files.length} tracked files scanned)`);
    process.exit(0);
  }

  console.error(`check-no-leaks: ${findings.length} finding(s) across ${files.length} tracked files\n`);
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, hits] of byFile) {
    console.error(`  ${file}`);
    for (const h of hits.slice(0, 5)) console.error(`    :${h.line}  ${h.rule}: ${h.hit}`);
    if (hits.length > 5) console.error(`    … and ${hits.length - 5} more in this file`);
  }
  console.error(
    "\nReplace with a placeholder that keeps the document readable: RFC 5737 " +
      "documentation addresses (203.0.113.x) for hosts, a neutral label for hostnames. " +
      "Do not delete evidence to silence this check.",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
