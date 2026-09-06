/**
 * `evaluateImgWrite` (src/adt/img-write-policy.ts) — the pure refusal policy
 * for `abap_img_edit`. One test per rule, in the same order the module
 * evaluates them, plus an ordering property, the `preview`-mode skip
 * behaviour, and a fully-allowed happy path.
 *
 * Deliberately imports nothing but vitest and the module under test — no
 * `ConfigSchema.parse(` anywhere here, so this file needs no entry on
 * `test/system-role-probe-guard.test.ts`'s allowlist (see that guard's own
 * header for why: a hand-built `SafetyConfig` object, as used throughout
 * this file, is not `loadConfig()` and carries no system-role probe to route).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateImgWrite,
  IMG_MAX_ROWS,
  type ImgWriteProbe,
  type ImgWriteRequest,
  type PolicyField,
  type PolicyTable,
} from "../src/adt/img-write-policy.js";
import type { SafetyConfig } from "../src/safety.js";

const FIELDS: readonly PolicyField[] = [
  { field: "MANDT", dataType: "CLNT", key: true },
  { field: "ZID", dataType: "CHAR", key: true },
  { field: "ZVAL", dataType: "CHAR", key: false },
];

function table(overrides: Partial<PolicyTable> = {}): PolicyTable {
  return {
    table: "ZTEST_TAB",
    clientDependent: true,
    deliveryClass: "C",
    fields: FIELDS,
    ...overrides,
  };
}

function probe(overrides: Partial<ImgWriteProbe> = {}): ImgWriteProbe {
  return {
    table: table(),
    targetKind: "view",
    cccoractiv: "1", // automatic recording on — corr_nr required regardless of clientDependent
    ...overrides,
  };
}

function req(overrides: Partial<ImgWriteRequest> = {}): ImgWriteRequest {
  return {
    mode: "upsert",
    rows: [{ ZID: "1", ZVAL: "X" }],
    corrNr: "XXXK900001",
    confirm: "ZTEST_TAB",
    ...overrides,
  };
}

function cfg(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    readOnly: false,
    allowPackages: [],
    productive: false,
    writesLockedOut: false,
    ...overrides,
  };
}

describe("evaluateImgWrite: rule 1 — productive system", () => {
  it("refuses when cfg.productive is true, no override", () => {
    const v = evaluateImgWrite(probe(), req(), cfg({ productive: true }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("productive-system");
  });

  it("refuses when the legacy systemRole is 'productive'", () => {
    const v = evaluateImgWrite(probe(), req(), cfg({ systemRole: "productive" }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("productive-system");
  });
});

describe("evaluateImgWrite: rule 2 — write lockout", () => {
  it("refuses when writesLockedOut is true, quoting lockoutReason", () => {
    const v = evaluateImgWrite(
      probe(),
      req(),
      cfg({ writesLockedOut: true, lockoutReason: "T000-CCCATEGORY = P for client 100." }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("write-lockout");
      expect(v.reason).toContain("T000-CCCATEGORY = P for client 100.");
    }
  });

  it("refuses when writesLockedOut is still undefined (probe not run yet) — fail closed, not fail open", () => {
    const c = cfg();
    delete c.writesLockedOut;
    const v = evaluateImgWrite(probe(), req(), c);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("write-lockout");
  });
});

describe("evaluateImgWrite: rule 3 — read-only", () => {
  it("refuses when the server is read-only", () => {
    const v = evaluateImgWrite(probe(), req(), cfg({ readOnly: true }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("read-only");
  });
});

describe("evaluateImgWrite: rule 4 — ambiguity", () => {
  it("refuses when the activity resolved to more than one candidate", () => {
    const v = evaluateImgWrite(probe({ ambiguity: "ZVIEW_A, ZVIEW_B" }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("ambiguous-target");
      expect(v.reason).toContain("ZVIEW_A, ZVIEW_B");
    }
  });

  it("wins over a delivery-class problem an ambiguous table would independently hit — the real defect this fix targets", () => {
    const v = evaluateImgWrite(
      probe({ ambiguity: "ZVIEW_A, ZVIEW_B", table: table({ deliveryClass: "A" }) }),
      req(),
      cfg(),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("ambiguous-target");
      expect(v.reason).toContain("ZVIEW_A, ZVIEW_B");
    }
  });
});

describe("evaluateImgWrite: rule 5 — target kind", () => {
  it("refuses an unrecognised target kind", () => {
    const v = evaluateImgWrite(probe({ targetKind: "other" }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("target-kind");
  });

  it.each(["view", "cluster", "table"] as const)("passes this rule for targetKind %s", (targetKind) => {
    const v = evaluateImgWrite(probe({ targetKind }), req(), cfg());
    if (!v.allowed) expect(v.rule).not.toBe("target-kind");
  });

  it("wins over a delivery-class problem the unmaintainable target's table would independently hit", () => {
    const v = evaluateImgWrite(
      probe({ targetKind: "other", table: table({ deliveryClass: "A" }) }),
      req(),
      cfg(),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("target-kind");
  });
});

describe("evaluateImgWrite: rule 6 — delivery class", () => {
  it.each(["A", "L", "S", "W", ""])("refuses delivery class %s", (deliveryClass) => {
    const v = evaluateImgWrite(probe({ table: table({ deliveryClass }) }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("delivery-class");
      if (deliveryClass) expect(v.reason).toContain(deliveryClass);
    }
  });

  it.each(["C", "G", "E"])("allows delivery class %s through this rule", (deliveryClass) => {
    const v = evaluateImgWrite(probe({ table: table({ deliveryClass }) }), req(), cfg());
    // May still be refused by a later rule in principle, but never by this one.
    if (!v.allowed) expect(v.rule).not.toBe("delivery-class");
  });
});

describe("evaluateImgWrite: rule 7 — cross-client", () => {
  it("refuses a client-independent table without allowCrossClient", () => {
    const v = evaluateImgWrite(probe({ table: table({ clientDependent: false }) }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("cross-client");
      expect(v.reason).toMatch(/every client/);
    }
  });

  it("passes this rule when allowCrossClient is true", () => {
    const v = evaluateImgWrite(
      probe({ table: table({ clientDependent: false }) }),
      req({ allowCrossClient: true }),
      cfg(),
    );
    if (!v.allowed) expect(v.rule).not.toBe("cross-client");
  });
});

describe("evaluateImgWrite: rule 8 — data-preview deny-list", () => {
  it("refuses a table on the default preview deny-list", () => {
    const v = evaluateImgWrite(probe({ table: table({ table: "USR02" }) }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("preview-deny-list");
      expect(v.reason).toContain("USR02");
    }
  });

  it("refuses a table on an operator-supplied deny addition", () => {
    const v = evaluateImgWrite(probe({ table: table({ table: "ZSECRET" }) }), req(), cfg(), {
      previewDenyExtra: ["ZSECRET"],
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("preview-deny-list");
  });
});

describe("evaluateImgWrite: rule 9 — row count", () => {
  it("refuses zero rows", () => {
    const v = evaluateImgWrite(probe(), req({ rows: [] }), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("row-count");
      expect(v.reason).toMatch(/nothing to write/);
    }
  });

  it(`refuses more than ${IMG_MAX_ROWS} rows`, () => {
    const rows = Array.from({ length: IMG_MAX_ROWS + 1 }, (_, i) => ({ ZID: String(i) }));
    const v = evaluateImgWrite(probe(), req({ rows }), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("row-count");
      expect(v.reason).toMatch(/split/i);
    }
  });

  it(`allows exactly ${IMG_MAX_ROWS} rows through this rule`, () => {
    const rows = Array.from({ length: IMG_MAX_ROWS }, (_, i) => ({ ZID: String(i) }));
    const v = evaluateImgWrite(probe(), req({ rows }), cfg());
    if (!v.allowed) expect(v.rule).not.toBe("row-count");
  });
});

describe("evaluateImgWrite: rule 10 — non-character key field", () => {
  it("refuses a key field whose data type is not character-like", () => {
    const badFields: readonly PolicyField[] = [
      { field: "MANDT", dataType: "CLNT", key: true },
      { field: "ZAMT", dataType: "RAW", key: true },
    ];
    const v = evaluateImgWrite(probe({ table: table({ fields: badFields }) }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("key-field-type");
      expect(v.reason).toContain("ZAMT");
      expect(v.reason).toContain("RAW");
    }
  });

  it("does not refuse a non-key field with an exotic data type", () => {
    const fields: readonly PolicyField[] = [
      { field: "MANDT", dataType: "CLNT", key: true },
      { field: "ZID", dataType: "CHAR", key: true },
      { field: "ZBLOB", dataType: "RAW", key: false },
    ];
    const v = evaluateImgWrite(probe({ table: table({ fields }) }), req(), cfg());
    if (!v.allowed) expect(v.rule).not.toBe("key-field-type");
  });
});

describe("evaluateImgWrite: rule 11 — T000-CCCORACTIV outright block", () => {
  it('refuses outright when CCCORACTIV is "2"', () => {
    const v = evaluateImgWrite(probe({ cccoractiv: "2" }), req(), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("cccoractiv");
      expect(v.reason).toContain('"2"');
    }
  });
});

describe("evaluateImgWrite: rule 12 — corr_nr required", () => {
  it("refuses a missing corr_nr when recording is required (CCCORACTIV = '1')", () => {
    const v = evaluateImgWrite(probe({ cccoractiv: "1" }), req({ corrNr: undefined }), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("corr-nr-required");
  });

  it("refuses a missing corr_nr on a client-independent table even when recording is off", () => {
    const v = evaluateImgWrite(
      probe({ cccoractiv: "", table: table({ clientDependent: false }) }),
      req({ corrNr: undefined, allowCrossClient: true }),
      cfg(),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("corr-nr-required");
  });

  it("does not require corr_nr when client-dependent AND recording is proven off", () => {
    const v = evaluateImgWrite(
      probe({ cccoractiv: "" }),
      req({ corrNr: undefined }),
      cfg(),
    );
    if (!v.allowed) expect(v.rule).not.toBe("corr-nr-required");
  });

  it("treats a blank/whitespace-only corr_nr as not supplied", () => {
    const v = evaluateImgWrite(probe({ cccoractiv: "1" }), req({ corrNr: "   " }), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("corr-nr-required");
  });
});

describe("evaluateImgWrite: rule 13 — corr_nr not allowed", () => {
  it("refuses a corr_nr not named by a pinned allowlist", () => {
    const v = evaluateImgWrite(
      probe(),
      req({ corrNr: "XXXK900001" }),
      cfg({ allowTransports: ["XXXK900002"] }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("corr-nr-not-allowed");
      expect(v.reason).toContain("XXXK900001");
    }
  });

  it("refuses any corr_nr when allowTransports is explicitly empty (deny-all)", () => {
    const v = evaluateImgWrite(probe(), req(), cfg({ allowTransports: [] }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.rule).toBe("corr-nr-not-allowed");
      expect(v.reason).toMatch(/deny-all/);
    }
  });

  it("permits any corr_nr when allowTransports is unset (default)", () => {
    const c = cfg();
    delete c.allowTransports;
    const v = evaluateImgWrite(probe(), req({ corrNr: "ANYTHING123" }), c);
    if (!v.allowed) expect(v.rule).not.toBe("corr-nr-not-allowed");
  });

  it("permits any corr_nr when allowTransports is '*'", () => {
    const v = evaluateImgWrite(probe(), req({ corrNr: "ANYTHING123" }), cfg({ allowTransports: ["*"] }));
    if (!v.allowed) expect(v.rule).not.toBe("corr-nr-not-allowed");
  });

  it("matches a pinned entry case-insensitively", () => {
    const v = evaluateImgWrite(
      probe(),
      req({ corrNr: "xxxk900001" }),
      cfg({ allowTransports: ["XXXK900001"] }),
    );
    if (!v.allowed) expect(v.rule).not.toBe("corr-nr-not-allowed");
  });
});

describe("evaluateImgWrite: rule 14 — confirm", () => {
  it("refuses upsert with no confirm", () => {
    const v = evaluateImgWrite(probe(), req({ confirm: undefined }), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("confirm-mismatch");
  });

  it("refuses delete when confirm names the activity/view instead of the base table", () => {
    const v = evaluateImgWrite(probe(), req({ mode: "delete", confirm: "SPRO_ACTIVITY_X" }), cfg());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("confirm-mismatch");
  });

  it("accepts confirm matching the base table case-insensitively and trimmed", () => {
    const v = evaluateImgWrite(probe(), req({ confirm: "  ztest_tab  " }), cfg());
    if (!v.allowed) expect(v.rule).not.toBe("confirm-mismatch");
  });
});

describe("evaluateImgWrite: ordering", () => {
  it("refuses a productive system before a delivery-class problem is even reached", () => {
    const v = evaluateImgWrite(
      probe({ table: table({ deliveryClass: "S" }) }),
      req(),
      cfg({ productive: true }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("productive-system");
  });

  it("refuses a productive system before an ambiguous target is even reached — system rules always win", () => {
    const v = evaluateImgWrite(
      probe({ ambiguity: "ZVIEW_A, ZVIEW_B" }),
      req(),
      cfg({ productive: true }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("productive-system");
  });
});

describe("evaluateImgWrite: preview mode skips corr_nr/confirm enforcement", () => {
  it("allows a preview with no corr_nr and no confirm, but notes what apply would demand", () => {
    const v = evaluateImgWrite(
      probe({ cccoractiv: "1" }),
      req({ mode: "preview", corrNr: undefined, confirm: undefined }),
      cfg(),
    );
    expect(v.allowed).toBe(true);
    if (v.allowed) {
      expect(v.notes.some((n) => /would refuse unless a transport request/.test(n))).toBe(true);
      expect(v.notes.some((n) => /would require confirm/.test(n))).toBe(true);
    }
  });

  it("a preview still enforces every other rule (e.g. delivery class)", () => {
    const v = evaluateImgWrite(
      probe({ table: table({ deliveryClass: "A" }) }),
      req({ mode: "preview", corrNr: undefined, confirm: undefined }),
      cfg(),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.rule).toBe("delivery-class");
  });
});

describe("evaluateImgWrite: happy path", () => {
  it("allows a fully valid upsert and discloses the view-event-module caveat", () => {
    const v = evaluateImgWrite(probe(), req(), cfg());
    expect(v.allowed).toBe(true);
    if (v.allowed) {
      expect(v.notes.some((n) => /table-maintenance-generator events/.test(n))).toBe(true);
    }
  });

  it("allows a fully valid delete the same way", () => {
    const v = evaluateImgWrite(probe(), req({ mode: "delete" }), cfg());
    expect(v.allowed).toBe(true);
  });
});
