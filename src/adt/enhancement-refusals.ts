/**
 * Specialises `translateAdtError`'s generic `ADT_ERROR` fallback (`./session.ts`
 * already handles LOCKED/SESSION_DEAD/NOT_FOUND/etc. upstream; not re-derived here)
 * for six known SAP refusal families:
 *  1. `ExceptionParameterNotFound` — corrNr missing (183-corrnr-absent-400.xml)
 *  2. `CTS_WBO_API` 037 — task (S) named where a request (K) is required (196-*.xml)
 *  3. `SADT_RESOURCE` 010 — no create/write handler at all, not a payload issue (275-*.xml)
 *  4. `SEDI_ADT` 015 — PUT line >255 chars, enforced before parsing (446-*.xml)
 *  5. `XT` 465 — tp-config misconfiguration blocking a booked-in object (543-*.xml)
 *  6. `text/html` session-destroying dumps — already handled upstream as
 *     SESSION_DEAD; listed only so coverage is auditable (272-*.xml, 273-*.txt)
 * All fixtures under `test/fixtures/enhancement/`.
 *
 * Do not match by prose or by `type/@id` alone — see
 * the git history for why (`type/@id` is not
 * a reliable discriminator; precedent in src/adt/transports.ts). Match on
 * `T100KEY-ID`+`T100KEY-NO` instead. Family #1 is the sole exception: its
 * capture has an empty `<properties/>`, so it matches on
 * `exceptionType === "ExceptionParameterNotFound"` plus the technical (non-prose)
 * parameter name `corrNr`.
 *
 * Fails closed: an ADT_ERROR matching no row below is returned UNCHANGED. Every
 * other AbapError code and every non-AbapError value also passes through untouched.
 *
 * `missingEnhancementWrapperError` below is a different kind of check: it does
 * not classify a server response at all (the "no prose, no type/@id" rule above
 * doesn't apply to it), it inspects the SOURCE THE CALLER SENT for an ENHO/XHH
 * write and explains a specific write-path rejection (`src/adt/write.ts`'s
 * `translateWriteFailure`) that the T100 table above cannot express, since
 * SAP's own message for it (a generic scan-failure envelope) names no problem.
 */
import { AbapError, isAbapError, type AbapErrorCode } from "./errors.js";
import { abapCodeOf } from "./source.js";

interface SapRefusal {
  exceptionType?: string;
  t100Id?: string;
  t100No?: string;
  code: AbapErrorCode;
  meaning: string;
}

const REFUSALS: readonly SapRefusal[] = [
  {
    // Family #2 — test/fixtures/enhancement/196-corrnr-task-not-request-400.xml
    t100Id: "CTS_WBO_API",
    t100No: "037",
    code: "TRANSPORT_ERROR",
    meaning:
      "a TASK was named where a transport REQUEST is required — SAP change requests have a task/request " +
      "hierarchy (S = task, K = request) and only the request (K) can be named as corr_nr here",
  },
  {
    // Family #3 — test/fixtures/enhancement/275-sadt-resource-no-create-handler-400.xml
    t100Id: "SADT_RESOURCE",
    t100No: "010",
    code: "ENHANCEMENT_CREATE_REFUSED",
    meaning:
      "this collection has no create/write handler for this operation at all — not a payload or schema " +
      "problem; retrying with a different body will not help",
  },
  {
    // Family #4 — test/fixtures/enhancement/446-put-line-too-long.xml
    t100Id: "SEDI_ADT",
    t100No: "015",
    code: "BAD_INPUT",
    meaning:
      "a source line exceeds 255 characters — ADT enforces this line-length limit before it even attempts " +
      "to parse the payload",
  },
  {
    // Family #5 — test/fixtures/enhancement/543-xt465-tp-config-delete-400.xml
    t100Id: "XT",
    t100No: "465",
    code: "TRANSPORT_ERROR",
    meaning:
      "the system's tp (transport control program) configuration is blocking this booked-in object — a " +
      "system/parameter misconfiguration, not something retrying or renaming a transport will fix",
  },
];

/**
 * `T100KEY-NO` is zero-padded in SAP's XML ("037") but abap-adt-api's
 * fast-xml-parser strips leading zeros before this module sees it ("37") —
 * verified against fixture 196. Not this module's parser to fix, so compare
 * numerically when both sides are digits-only; see archive for full analysis.
 */
function sameT100No(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b);
  return false;
}

function findByT100(t100Id: string | undefined, t100No: string | undefined): SapRefusal | undefined {
  if (!t100Id || !t100No) return undefined;
  return REFUSALS.find((r) => r.t100Id === t100Id && r.t100No !== undefined && sameT100No(r.t100No, t100No));
}

/**
 * Returns `e` unchanged unless it's an ADT_ERROR-coded AbapError matching one
 * of the refusal families above. Usage: `catch (e) { return
 * deps.errorResult(classifyEnhancementRefusal(e)); }` in enhancement-write.ts.
 */
export function classifyEnhancementRefusal(e: unknown): unknown {
  if (!isAbapError(e) || e.code !== "ADT_ERROR") return e;

  const props = (e.details.properties as Record<string, string> | undefined) ?? {};
  const exceptionType = e.details.adtExceptionType as string | undefined;

  // Family #1 (183-corrnr-absent-400.xml): empty <properties/>, matched on
  // exceptionType + corrNr per module header.
  if (exceptionType === "ExceptionParameterNotFound" && /\bcorrNr\b/i.test(e.message)) {
    return new AbapError(
      "TRANSPORT_ERROR",
      `${e.message} — this write needs a transport request (corr_nr) and none was supplied or resolved`,
      e.details,
      "Pass corr_nr explicitly, or write to a $TMP-local object that needs no transport at all.",
    );
  }

  const hit = findByT100(props["T100KEY-ID"], props["T100KEY-NO"]);
  if (hit) {
    return new AbapError(hit.code, `${e.message} — ${hit.meaning}`, e.details, e.hint);
  }

  // Fail closed — nothing named above matched; the raw ADT_ERROR envelope is preserved as-is.
  return e;
}

/**
 * An ENHO/XHH `/source/main` body is not a program: it is one or more
 * `ENHANCEMENT <n>. ... ENDENHANCEMENT.` blocks, where `<n>` is the
 * `hookImplementation/@id` from the create document and nothing follows it.
 * SAP's own SEEF_ADT_HOOK 001 long text spells the accepted form
 * `ENHANCEMENT n.`; a live PUT of `ENHANCEMENT 1 ZMCP_ENH_B.` was rejected 400
 * where `ENHANCEMENT 1  .` saved. The named form belongs to the enhanced
 * object's own source, not to this document.
 *
 * A caller who PUTs the bare statements gets them read as a headerless program
 * and the save refused with `ExceptionResourceScanDuringSaveFailure`.
 * `serverMessage` is that refusal's envelope — the generic "Scan of resource
 * failed" in every capture held here, which is why the REPORT/PROGRAM wording
 * a caller eventually sees comes from `check`, the checkrun run alongside it,
 * and not from the PUT response.
 *
 * Deliberately does not auto-wrap the source: the number is server-assigned,
 * and guessing it wrong would write a subtly broken object rather than fail
 * loudly. Callers are pointed at `abap_read` (plain source mode) instead.
 */
export function missingEnhancementWrapperError(
  target: { name: string; type: string; uri: string },
  source: string,
  serverMessage: string | undefined,
  check?: { summary: string; messages: string; raw: unknown },
): AbapError | undefined {
  if (target.type !== "ENHO/XHH") return undefined;

  const hasWrapper = source.split(/\r?\n/).some((line) => /\bENDENHANCEMENT\b/i.test(abapCodeOf(line)));
  if (hasWrapper) return undefined;

  return new AbapError(
    "CHECK_FAILED",
    `The ABAP system rejected the source of ${target.type} ${target.name}: ` +
      `${serverMessage ?? "the save was rejected"} — this source has no ENHANCEMENT ... ` +
      "ENDENHANCEMENT wrapper. An ENHO/XHH /source/main body is not a program, it is one or more " +
      "`ENHANCEMENT <n>. ... ENDENHANCEMENT.` blocks — the server's number and nothing else, no " +
      "name after it — so a bare statement body is parsed as a program with no header." +
      (check ? ` The syntax check describes that mis-parse rather than the missing wrapper: ${check.summary}.` : ""),
    {
      name: target.name,
      type: target.type,
      uri: target.uri,
      missing: "ENHANCEMENT/ENDENHANCEMENT",
      originalMessage: serverMessage,
      ...(check ? { summary: check.summary, messages: check.messages, raw: check.raw } : {}),
    },
    `Read the object first — abap_read(object:"${target.name}", type:"ENHO/XHH") in plain source ` +
      "mode, NOT enhancements:true — and write back exactly the header line it returns with your " +
      "statements inside its ENHANCEMENT ... ENDENHANCEMENT block. The number in that header is " +
      "the server's: do not invent one, and do not add an enhancement name after it — this " +
      "resource rejects the named form. The object was NOT changed and the lock was released.",
  );
}
