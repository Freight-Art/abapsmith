/**
 * `datapreview-filter.ts` compiles a structured filter (`where`/`columns`/
 * `order_by`/`distinct`) into an Open SQL `SELECT` for the DDIC data-preview
 * freestyle endpoint (issue #73). It is pure — no `AbapConnection`, no HTTP —
 * so every test here is a plain function call, not a cassette replay.
 *
 * The exact renderings asserted below (`toBe`, not a loose match) are not
 * this test file's invention: per the module's own header, they were pasted
 * into a $TMP ABAP report on the live A4H appliance and syntax-checked clean.
 * Changing what this module renders without re-checking against a real
 * system risks shipping SQL that merely looks right.
 */
import { describe, expect, it } from "vitest";

import {
  assertFilterShape,
  isEmptyFilter,
  MAX_COLUMNS,
  MAX_IN_VALUES,
  MAX_ORDER_BY,
  MAX_VALUE_LENGTH,
  MAX_WHERE_CONDITIONS,
  PREVIEW_OPS,
  PREVIEW_SQL_LINE_MAX,
  renderPreviewSelect,
  type PreviewCondition,
  type PreviewFilter,
  type PreviewOp,
  type PreviewOrder,
} from "../src/adt/datapreview-filter.js";
import type { PreviewColumn } from "../src/adt/datapreview.js";
import { AbapError } from "../src/adt/errors.js";

// ------------------------------------------------------------------- fixture ---

/**
 * TB003's shape as the preview endpoint actually reports it — the type codes
 * (C/N/P/I/D) are the ones measured on the wire, not a guessed DDIC mapping.
 * `key` is `false` on every column here on purpose: the module's own header
 * records that A4H's preview metadata reports `keyAttribute: "false"` for
 * every column of every entity, even TB003 whose real key is CLIENT+ROLE —
 * so `PreviewColumn.key` is never trustworthy input for this module, and a
 * fixture that set it `true` would be testing a shape the wire never sends.
 */
const COLS: PreviewColumn[] = [
  { name: "CLIENT", type: "C", length: 3, key: false },
  { name: "ROLE", type: "C", length: 6, key: false },
  { name: "ROLECATEGORY", type: "C", length: 6, key: false },
  { name: "POSNR", type: "N", length: 3, key: false },
  { name: "PRICE", type: "P", length: 10, key: false },
  { name: "CNT", type: "I", length: 10, key: false },
  { name: "FLDATE", type: "D", length: 10, key: false },
];

const KNOWN_COLUMNS_LIST = "CLIENT, ROLE, ROLECATEGORY, POSNR, PRICE, CNT, FLDATE";

function expectAbapError(fn: () => unknown, code: string): AbapError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(AbapError);
  const err = thrown as AbapError;
  expect(err.code).toBe(code);
  return err;
}

/** Every physical line of a rendered statement must fit the wire's wrap width. */
function expectLinesWithinLimit(sql: string): void {
  for (const line of sql.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(PREVIEW_SQL_LINE_MAX);
  }
}

// =============================================================== isEmptyFilter ===

describe("isEmptyFilter", () => {
  it("treats undefined as empty — the no-filter call path must stay byte-identical to pre-#73", () => {
    expect(isEmptyFilter(undefined)).toBe(true);
  });

  it("treats {} as empty", () => {
    expect(isEmptyFilter({})).toBe(true);
  });

  it("treats an empty where array as empty", () => {
    expect(isEmptyFilter({ where: [] })).toBe(true);
  });

  it("treats an empty columns array as empty", () => {
    expect(isEmptyFilter({ columns: [] })).toBe(true);
  });

  it("treats an empty order_by array as empty", () => {
    expect(isEmptyFilter({ orderBy: [] })).toBe(true);
  });

  it("treats distinct: false as empty", () => {
    expect(isEmptyFilter({ distinct: false })).toBe(true);
  });

  it("does NOT treat distinct: true as empty, even with nothing else set", () => {
    // SELECT DISTINCT * is a different statement from the plain ddic read —
    // this is the one flag that must force the filtered code path alone.
    expect(isEmptyFilter({ distinct: true })).toBe(false);
  });

  it("does not treat a non-empty where array as empty", () => {
    expect(isEmptyFilter({ where: [{ field: "ROLE", op: "is_null" }] })).toBe(false);
  });

  it("does not treat a non-empty columns array as empty", () => {
    expect(isEmptyFilter({ columns: ["ROLE"] })).toBe(false);
  });

  it("does not treat a non-empty order_by array as empty", () => {
    expect(isEmptyFilter({ orderBy: [{ field: "ROLE" }] })).toBe(false);
  });
});

// ============================================================ exact renderings ===

describe("renderPreviewSelect — exact renderings pinned against the live syntax check", () => {
  it("case 1: a case-insensitive field name in where is resolved and rendered in the server's own upper-case spelling", () => {
    const sql = renderPreviewSelect(
      "TB003",
      {
        where: [{ field: "rolecategory", op: "eq", value: "BUP001" }],
        columns: ["ROLE", "ROLECATEGORY"],
        orderBy: [{ field: "ROLE" }],
      },
      COLS,
    );
    // The caller wrote "rolecategory" (lower-case); the rendered SQL says
    // ROLECATEGORY — the server's own spelling from PreviewColumn.name, never
    // whatever case the caller happened to type.
    expect(sql).toBe(
      ["SELECT", "  ROLE,", "  ROLECATEGORY", "FROM TB003", "WHERE ROLECATEGORY = 'BUP001'", "ORDER BY ROLE ASCENDING"].join(
        "\n",
      ),
    );
  });

  it("case 2: a caller's apostrophe is doubled, never terminates the literal (anti-injection)", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "ROLE", op: "eq", value: "Walldorf's" }] }, COLS);
    // If this ever rendered `= 'Walldorf's'` unescaped, the literal would
    // terminate early and the rest of the caller's string would land in the
    // SQL grammar itself — the doubled quote is what keeps it inert.
    expect(sql).toBe(["SELECT *", "FROM TB003", "WHERE ROLE = 'Walldorf''s'"].join("\n"));
  });

  it("case 3: an IN list wraps at 5 items per line", () => {
    const sql = renderPreviewSelect(
      "TB003",
      { where: [{ field: "ROLE", op: "in", value: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"] }] },
      COLS,
    );
    expect(sql).toBe(
      ["SELECT *", "FROM TB003", "WHERE ROLE IN (", "  'A1', 'A2', 'A3', 'A4', 'A5',", "  'A6', 'A7', 'A8'", ")"].join("\n"),
    );
  });

  it("case 4: mixed typed literals across ge/gt/is_null, plus a two-key ORDER BY", () => {
    const sql = renderPreviewSelect(
      "TB003",
      {
        where: [
          { field: "PRICE", op: "ge", value: 422.94 },
          { field: "CNT", op: "gt", value: 300 },
          { field: "FLDATE", op: "ge", value: "2017-01-01" },
          { field: "ROLE", op: "is_null" },
        ],
        orderBy: [{ field: "POSNR", direction: "desc" }, { field: "ROLE", direction: "asc" }],
      },
      COLS,
    );
    expect(sql).toBe(
      [
        "SELECT *",
        "FROM TB003",
        "WHERE PRICE >= '422.94'",
        "  AND CNT > 300",
        "  AND FLDATE >= '20170101'",
        "  AND ROLE IS NULL",
        "ORDER BY POSNR DESCENDING, ROLE ASCENDING",
      ].join("\n"),
    );
  });

  it("case 5: LIKE on a character-like NUMC field escapes with ESCAPE '#'", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "POSNR", op: "like", value: "0#_%" }] }, COLS);
    expect(sql).toBe(["SELECT *", "FROM TB003", "WHERE POSNR LIKE '0#_%' ESCAPE '#'"].join("\n"));
  });

  it("case 6a: distinct with no projection", () => {
    const sql = renderPreviewSelect("TB003", { distinct: true }, COLS);
    expect(sql).toBe(["SELECT DISTINCT *", "FROM TB003"].join("\n"));
  });

  it("case 6b: distinct with an explicit projection", () => {
    const sql = renderPreviewSelect("TB003", { distinct: true, columns: ["ROLE", "ROLECATEGORY"] }, COLS);
    expect(sql).toBe(["SELECT DISTINCT", "  ROLE,", "  ROLECATEGORY", "FROM TB003"].join("\n"));
  });
});

// ==================================================================== typing ===

describe("renderPreviewSelect — per-type literal rules measured live", () => {
  it("a packed/decimal field (type P) is rendered QUOTED — unquoted is an Open SQL syntax error", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "PRICE", op: "ge", value: 100 }] }, COLS);
    expect(sql).toContain("WHERE PRICE >= '100'");
  });

  it("an integer field (type I) is rendered UNQUOTED", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "CNT", op: "gt", value: 300 }] }, COLS);
    expect(sql).toContain("WHERE CNT > 300");
  });

  it("a DATS field (type D) accepts a dashed date and renders the 8-char quoted form", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "FLDATE", op: "ge", value: "2017-01-01" }] }, COLS);
    expect(sql).toContain("WHERE FLDATE >= '20170101'");
  });

  it("a DATS field also accepts the bare 8-digit form, rendering identically to the dashed input", () => {
    const dashed = renderPreviewSelect("TB003", { where: [{ field: "FLDATE", op: "ge", value: "2017-01-01" }] }, COLS);
    const bare = renderPreviewSelect("TB003", { where: [{ field: "FLDATE", op: "ge", value: "20170101" }] }, COLS);
    expect(bare).toBe(dashed);
  });

  it("ORDER BY directions are spelled out in full — ASC/DESC are not accepted by this compiler", () => {
    const sql = renderPreviewSelect("TB003", { orderBy: [{ field: "ROLE", direction: "desc" }] }, COLS);
    expect(sql).toContain("ORDER BY ROLE DESCENDING");
    expect(sql).not.toContain("DESC\n");
    expect(sql).not.toContain(" DESC ");
  });
});

// ===================================================================== LIKE ===

describe("renderPreviewSelect — LIKE escaping", () => {
  it("passes the caller's %, _ and # through verbatim — this is SQL LIKE grammar, not img-query's *-to-% translation", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "ROLE", op: "like", value: "A_%#B" }] }, COLS);
    expect(sql).toContain("WHERE ROLE LIKE 'A_%#B' ESCAPE '#'");
  });

  it("still doubles an embedded quote inside a LIKE pattern, so the rendered pattern differs from the caller's raw string", () => {
    const sql = renderPreviewSelect("TB003", { where: [{ field: "ROLE", op: "like", value: "A'B_%" }] }, COLS);
    // Raw input: A'B_%  — rendered pattern: A''B_% (only the quote changes).
    expect(sql).toContain("WHERE ROLE LIKE 'A''B_%' ESCAPE '#'");
  });

  it("refuses LIKE on a numeric field (type I), quoting the compiler's own wording", () => {
    const err = expectAbapError(
      () => renderPreviewSelect("TB003", { where: [{ field: "CNT", op: "like", value: "3%" }] }, COLS),
      "BAD_INPUT",
    );
    expect(err.message).toContain("a numeric field");
    expect(err.message).toContain("A LIKE condition can only be used with character-like fields.");
  });

  it("allows LIKE on a NUMC field (type N) — NUMC is stored character-like on the wire, unlike I/P", () => {
    // This is the deny-list-not-allow-list point made in the module's own
    // comment: N is not in NUMERIC_TYPE_CODES, so it is let through untested
    // rather than refused on a guess.
    expect(() => renderPreviewSelect("TB003", { where: [{ field: "POSNR", op: "like", value: "0%" }] }, COLS)).not.toThrow();
  });
});

// ================================================================= client field ===

describe("renderPreviewSelect — the client field", () => {
  it("refuses a WHERE condition on the client field, quoting the compiler's own wording", () => {
    const err = expectAbapError(
      () => renderPreviewSelect("TB003", { where: [{ field: "CLIENT", op: "eq", value: "001" }] }, COLS),
      "BAD_INPUT",
    );
    expect(err.message).toContain("client field");
    expect(err.message).toContain(
      'The client field "CLIENT" cannot be specified in the WHERE condition. Client handling is performed by the compiler.',
    );
  });

  it("allows the client field in columns and in order_by — only a WHERE condition on it is refused", () => {
    // Companion to the refusal above: this asymmetry (fine in projection and
    // ordering, refused only in WHERE) is the live-measured behaviour and is
    // easy to break by over-generalising the client-field guard.
    const sql = renderPreviewSelect("TB003", { columns: ["CLIENT", "ROLE"], orderBy: [{ field: "CLIENT" }] }, COLS);
    expect(sql).toBe(["SELECT", "  CLIENT,", "  ROLE", "FROM TB003", "ORDER BY CLIENT ASCENDING"].join("\n"));
  });
});

// ============================================================== distinct+order ===

describe("renderPreviewSelect — distinct + order_by projection rule", () => {
  it("refuses distinct with an order_by field outside columns, quoting the compiler's own wording", () => {
    const err = expectAbapError(
      () => renderPreviewSelect("TB003", { distinct: true, columns: ["ROLE"], orderBy: [{ field: "POSNR" }] }, COLS),
      "BAD_INPUT",
    );
    expect(err.message).toContain('is not in "columns"');
    expect(err.message).toContain('missing in the SELECT list');
  });

  it("allows distinct with an order_by field that IS in columns (positive control for the refusal above)", () => {
    const sql = renderPreviewSelect("TB003", { distinct: true, columns: ["ROLE"], orderBy: [{ field: "ROLE" }] }, COLS);
    expect(sql).toBe(["SELECT DISTINCT", "  ROLE", "FROM TB003", "ORDER BY ROLE ASCENDING"].join("\n"));
  });

  it("without distinct, an order_by field outside columns is fine (the rule is scoped to distinct only)", () => {
    expect(() => renderPreviewSelect("TB003", { columns: ["ROLE"], orderBy: [{ field: "POSNR" }] }, COLS)).not.toThrow();
  });
});

// ==================================================================== refusals ===

describe("renderPreviewSelect — unknown fields name the known columns", () => {
  it("refuses an unknown where field and lists every known column", () => {
    const err = expectAbapError(
      () => renderPreviewSelect("TB003", { where: [{ field: "ROLECAT", op: "eq", value: "X" }] }, COLS),
      "BAD_INPUT",
    );
    expect(err.message).toContain('where[0].field "ROLECAT" is not a column of this entity.');
    expect(err.message).toContain(`Known columns: ${KNOWN_COLUMNS_LIST}.`);
  });

  it("refuses an unknown columns entry, same known-columns wording", () => {
    const err = expectAbapError(() => renderPreviewSelect("TB003", { columns: ["ROLECAT"] }, COLS), "BAD_INPUT");
    expect(err.message).toContain('columns[0] "ROLECAT" is not a column of this entity.');
    expect(err.message).toContain(`Known columns: ${KNOWN_COLUMNS_LIST}.`);
  });

  it("refuses an unknown order_by field, same known-columns wording", () => {
    const err = expectAbapError(
      () => renderPreviewSelect("TB003", { orderBy: [{ field: "ROLECAT" }] }, COLS),
      "BAD_INPUT",
    );
    expect(err.message).toContain('order_by[0].field "ROLECAT" is not a column of this entity.');
    expect(err.message).toContain(`Known columns: ${KNOWN_COLUMNS_LIST}.`);
  });
});

describe("assertFilterShape — operator and value shape, zero wire cost", () => {
  it("refuses an unrecognised operator, building the accepted-values list from PREVIEW_OPS itself", () => {
    const cond: PreviewCondition = { field: "ROLE", op: "contains" as PreviewOp, value: "x" };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain("not a recognised operator");
    expect(err.message).toContain(`accepted values are: ${PREVIEW_OPS.join(", ")}.`);
  });

  it("refuses a value containing a freestyle-banned keyword before any column metadata is involved", () => {
    // Caught by assertFilterShape alone — no PreviewColumn[] is passed in,
    // proving this check costs zero wire calls.
    const err = expectAbapError(
      () => assertFilterShape({ where: [{ field: "ROLE", op: "eq", value: "DROP TABLE" }] }),
      "BAD_INPUT",
    );
    expect(err.message).toContain('the word "DROP"');
    expect(err.message).toContain("freestyle endpoint's own banned-keyword");
  });

  it("refuses a non-finite number (NaN)", () => {
    const cond: PreviewCondition = { field: "ROLE", op: "eq", value: NaN };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain("where value for ROLE must be a string or a finite number");
  });

  it("refuses a non-finite number (Infinity)", () => {
    const cond: PreviewCondition = { field: "ROLE", op: "eq", value: Infinity };
    expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
  });

  it("refuses null as a scalar value", () => {
    const cond = { field: "ROLE", op: "eq" as const, value: null } as unknown as PreviewCondition;
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain("where value for ROLE must be a string or a finite number");
  });

  it("refuses an object as a scalar value", () => {
    const cond = { field: "ROLE", op: "eq" as const, value: {} } as unknown as PreviewCondition;
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain("got {}");
  });

  it("refuses a boolean as a scalar value", () => {
    const cond = { field: "ROLE", op: "eq" as const, value: true } as unknown as PreviewCondition;
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain("got true");
  });

  it('refuses an array "value" for a non-"in" operator', () => {
    const cond: PreviewCondition = { field: "ROLE", op: "eq", value: ["a", "b"] };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain('must not supply an array "value" — only "in" takes a list.');
  });

  it('refuses a non-array "value" for op "in"', () => {
    const cond: PreviewCondition = { field: "ROLE", op: "in", value: "X" };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain('has op "in" but "value" is not a non-empty array.');
  });

  it('refuses an empty array "value" for op "in"', () => {
    const cond: PreviewCondition = { field: "ROLE", op: "in", value: [] };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain('has op "in" but "value" is not a non-empty array.');
  });

  it('refuses a "value" supplied together with op "is_null"', () => {
    const cond: PreviewCondition = { field: "ROLE", op: "is_null", value: "X" };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain('has op "is_null" but also supplies a "value"');
  });

  it("refuses a missing value for an operator that requires one", () => {
    const cond: PreviewCondition = { field: "ROLE", op: "eq" };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain('(op "eq") requires a "value".');
  });

  it("refuses an invalid order_by direction", () => {
    const badDirection = "ASC" as unknown as "asc" | "desc";
    const order: PreviewOrder = { field: "ROLE", direction: badDirection };
    const err = expectAbapError(() => assertFilterShape({ orderBy: [order] }), "BAD_INPUT");
    expect(err.message).toContain('order_by[0].direction "ASC" must be "asc" or "desc" (or omitted).');
  });

  it("refuses a duplicate columns entry, case-insensitively", () => {
    const err = expectAbapError(() => assertFilterShape({ columns: ["ROLE", "role"] }), "BAD_INPUT");
    expect(err.message).toContain('"columns" names "role" more than once (case-insensitive)');
  });
});

describe("renderPreviewSelect — order_by has no duplicate-field guard, unlike columns", () => {
  it("renders the same field twice in ORDER BY without complaint if the caller asks for that", () => {
    // Documenting real behaviour, not assuming it: assertOrder only checks
    // field-non-empty and direction — there is no case-insensitive dedup
    // pass over order_by the way there is over columns. Worth knowing if
    // this module is ever extended.
    const sql = renderPreviewSelect(
      "TB003",
      { orderBy: [{ field: "ROLE" }, { field: "role", direction: "desc" }] },
      COLS,
    );
    expect(sql).toBe(["SELECT *", "FROM TB003", "ORDER BY ROLE ASCENDING, ROLE DESCENDING"].join("\n"));
  });
});

// ===================================================================== limits ===

describe("assertFilterShape — every cap names itself in the refusal", () => {
  it("refuses one where condition over MAX_WHERE_CONDITIONS", () => {
    const where: PreviewCondition[] = Array.from({ length: MAX_WHERE_CONDITIONS + 1 }, () => ({
      field: "ROLE",
      op: "eq" as const,
      value: "X",
    }));
    const err = expectAbapError(() => assertFilterShape({ where }), "BAD_INPUT");
    expect(err.message).toContain(
      `"where" has ${MAX_WHERE_CONDITIONS + 1} conditions, over the ${MAX_WHERE_CONDITIONS}-condition cap.`,
    );
  });

  it("refuses one order_by entry over MAX_ORDER_BY", () => {
    const orderBy: PreviewOrder[] = Array.from({ length: MAX_ORDER_BY + 1 }, () => ({ field: "ROLE" }));
    const err = expectAbapError(() => assertFilterShape({ orderBy }), "BAD_INPUT");
    expect(err.message).toContain(`"order_by" has ${MAX_ORDER_BY + 1} entries, over the ${MAX_ORDER_BY}-entry cap.`);
  });

  it("refuses one columns entry over MAX_COLUMNS", () => {
    const columns: string[] = Array.from({ length: MAX_COLUMNS + 1 }, () => "X");
    const err = expectAbapError(() => assertFilterShape({ columns }), "BAD_INPUT");
    expect(err.message).toContain(`"columns" has ${MAX_COLUMNS + 1} entries, over the ${MAX_COLUMNS}-column cap.`);
  });

  it("refuses one IN value over MAX_IN_VALUES on a single condition", () => {
    const value: string[] = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `V${i}`);
    const cond: PreviewCondition = { field: "ROLE", op: "in", value };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain(
      `where[0] has ${MAX_IN_VALUES + 1} values in its "in" list, over the ${MAX_IN_VALUES}-value cap per condition.`,
    );
  });

  it("refuses one character over MAX_VALUE_LENGTH on a scalar where value", () => {
    const value = "A".repeat(MAX_VALUE_LENGTH + 1);
    const cond: PreviewCondition = { field: "ROLE", op: "eq", value };
    const err = expectAbapError(() => assertFilterShape({ where: [cond] }), "BAD_INPUT");
    expect(err.message).toContain(
      `is ${MAX_VALUE_LENGTH + 1} characters, longer than the ${MAX_VALUE_LENGTH}-character limit.`,
    );
  });
});

// ============================================================== line wrapping ===

describe("renderPreviewSelect — PREVIEW_SQL_LINE_MAX", () => {
  it("every line of cases 1-6 fits within PREVIEW_SQL_LINE_MAX", () => {
    const filters: [PreviewFilter, PreviewColumn[]][] = [
      [
        {
          where: [{ field: "rolecategory", op: "eq", value: "BUP001" }],
          columns: ["ROLE", "ROLECATEGORY"],
          orderBy: [{ field: "ROLE" }],
        },
        COLS,
      ],
      [{ where: [{ field: "ROLE", op: "eq", value: "Walldorf's" }] }, COLS],
      [{ where: [{ field: "ROLE", op: "in", value: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"] }] }, COLS],
      [
        {
          where: [
            { field: "PRICE", op: "ge", value: 422.94 },
            { field: "CNT", op: "gt", value: 300 },
            { field: "FLDATE", op: "ge", value: "2017-01-01" },
            { field: "ROLE", op: "is_null" },
          ],
          orderBy: [{ field: "POSNR", direction: "desc" }, { field: "ROLE", direction: "asc" }],
        },
        COLS,
      ],
      [{ where: [{ field: "POSNR", op: "like", value: "0#_%" }] }, COLS],
      [{ distinct: true, columns: ["ROLE", "ROLECATEGORY"] }, COLS],
    ];
    for (const [filter, cols] of filters) {
      expectLinesWithinLimit(renderPreviewSelect("TB003", filter, cols));
    }
  });

  it("wraps a long IN list into multiple lines each within PREVIEW_SQL_LINE_MAX, even though the unwrapped single line would have exceeded it", () => {
    const values = Array.from({ length: 50 }, (_, i) => `VALUE${String(i).padStart(2, "0")}`);
    // If this were rendered as one line (no 5-per-line wrap), quoting and
    // separators alone would push it well past the limit — computed
    // independently of the module's own wrapping logic, so this is a real
    // check that wrapping is doing something, not a tautology.
    const unwrappedLength = `ROLE IN (${values.map((v) => `'${v}'`).join(", ")})`.length;
    expect(unwrappedLength).toBeGreaterThan(PREVIEW_SQL_LINE_MAX);

    const sql = renderPreviewSelect("TB003", { where: [{ field: "ROLE", op: "in", value: values }] }, COLS);
    expectLinesWithinLimit(sql);
    expect(sql.split("\n").length).toBeGreaterThan(1);
  });

  it("refuses (CHECK_FAILED) a statement whose rendered line would exceed PREVIEW_SQL_LINE_MAX even after wrapping", () => {
    // 5 values of 60 chars each is within every per-value/per-list cap, but
    // a single wrapped line of 5 such quoted literals is far longer than
    // PREVIEW_SQL_LINE_MAX — this is the render-time backstop, distinct from
    // the BAD_INPUT shape caps above.
    const values = Array.from({ length: 5 }, () => "X".repeat(60));
    const err = expectAbapError(
      () => renderPreviewSelect("TB003", { where: [{ field: "ROLE", op: "in", value: values }] }, COLS),
      "CHECK_FAILED",
    );
    expect(err.message).toContain(`${PREVIEW_SQL_LINE_MAX}-char`);
  });
});
