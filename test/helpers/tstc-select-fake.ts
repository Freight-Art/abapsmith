/**
 * The TSTC pre-check (src/adt/ui-tstc.ts, issue #150) as a reusable test
 * fake. It is one more `POST /sap/bc/adt/datapreview/freestyle` — the same
 * path `detectSystemRole()` probes at connect time — so a fake that keys the
 * data-preview path on URL alone (`systemRoleProbeResponse`) would answer
 * the TSTC select with the T000 body and the lookup would see no TCODE
 * column. Match on the statement in the request body instead, and check it
 * BEFORE the generic data-preview branch.
 *
 * The body is built in the exact column-major shape of the live capture
 * `087-p3b-datapreview-t000.xml` (see test/helpers/system-role-fake.ts),
 * with the five columns `buildTransactionDetailQuery` selects; only the row
 * values are synthetic.
 */
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { DATA_PREVIEW_PATH, DATAPREVIEW_XML } from "./system-role-fake.js";

export interface TstcRow {
  readonly TCODE: string;
  readonly PGMNA: string;
  readonly DYPNO: string;
  readonly CINFO: string;
  readonly ARBGB?: string;
}

const TSTC_COLUMNS = ["TCODE", "PGMNA", "DYPNO", "CINFO", "ARBGB"] as const;

/** True for the one request `lookupTransaction` puts on the wire: a data-preview POST whose SQL reads TSTC. */
export function isTstcSelect(o: { url?: string; body?: string } | undefined): boolean {
  return typeof o?.url === "string" && o.url.includes(DATA_PREVIEW_PATH) && /FROM TSTC\b/.test(o.body ?? "");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A 200 data-preview body carrying `rows` (empty array = "no such transaction"). */
export function tstcSelectResponse(rows: readonly TstcRow[]): HttpClientResponse {
  const columns = TSTC_COLUMNS.map((name) => {
    const cells = rows
      .map((r) => `<dataPreview:data>${esc(name === "ARBGB" ? (r.ARBGB ?? "") : r[name])}</dataPreview:data>`)
      .join("");
    return (
      `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" ` +
      `dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="C" ` +
      `dataPreview:isKeyFigure="false" dataPreview:length="40"/>` +
      `<dataPreview:dataSet>${cells}</dataPreview:dataSet></dataPreview:columns>`
    );
  }).join("");
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
    `<dataPreview:totalRows>${rows.length}</dataPreview:totalRows>` +
    `<dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>` +
    `<dataPreview:executionTime>1</dataPreview:executionTime>` +
    `<dataPreview:queryExecutionTime>0.5</dataPreview:queryExecutionTime>` +
    `<dataPreview:name>TSTC</dataPreview:name>${columns}</dataPreview:tableData>`;
  return { status: 200, statusText: "200", body, headers: DATAPREVIEW_XML } as unknown as HttpClientResponse;
}

/** Composable branch: answers a TSTC select from `rows`, returns undefined for every other request. */
export function tstcSelectRoute(rows: readonly TstcRow[]): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o) => (isTstcSelect(o) ? tstcSelectResponse(rows) : undefined);
}
