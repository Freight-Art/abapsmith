/** Pure generator tests for `abap_rap` (issue #197) — no I/O, no server. */
import { describe, it, expect } from "vitest";
import { deriveRapNames, generateRapStack, type RapNames } from "../src/adt/rap-generate.js";
import { AbapError } from "../src/adt/errors.js";
import type { DdlField } from "../src/adt/ddic.js";

const FIELDS: DdlField[] = [
  { name: "MANDT", type: "abap.clnt", key: true, notNull: true },
  { name: "BOOKING_UUID", type: "sysuuid_x16", key: true, notNull: true },
  { name: "CUSTOMER_ID", type: "abap.char(10)", key: false, notNull: false },
  { name: "BOOKING_DATE", type: "abap.dats", key: false, notNull: false },
  { name: "AMOUNT", type: "abap.dec(15,2)", key: false, notNull: false },
  { name: "CURRENCY_CODE", type: "abap.cuky", key: false, notNull: false },
  { name: "STATUS", type: "abap.char(1)", key: false, notNull: false },
  { name: "LAST_CHANGED_AT", type: "timestampl", key: false, notNull: false },
];

const FIELDS_NO_TIMESTAMP: DdlField[] = FIELDS.filter((f) => f.name !== "LAST_CHANGED_AT");

const TABLE = "ZAS_BOOKING197";
const PACKAGE = "ZAS_BK197_PKG";
const PREFIX = "ZAS_BK197";

function names(bindingType: "V2" | "V4" = "V4"): RapNames {
  return deriveRapNames(PREFIX, { bindingType });
}

function baseSpec(overrides: Record<string, unknown> = {}) {
  const bindingType = (overrides.bindingType as "V2" | "V4") ?? "V4";
  const n = (overrides.names as RapNames) ?? names(bindingType);
  const base = {
    table: TABLE,
    package: PACKAGE,
    names: n,
    alias: n.alias,
    fields: FIELDS,
    flavour: "managed",
    draft: false,
    bindingType,
    includeProjection: true,
    cdsForm: "entity",
  };
  return { ...base, ...overrides, names: n } as Parameters<typeof generateRapStack>[0];
}

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AbapError) return e.code;
    throw e;
  }
  throw new Error("expected a throw, got none");
}

describe("deriveRapNames", () => {
  it("derives every name from a customer-namespace prefix", () => {
    const n = deriveRapNames(PREFIX, { bindingType: "V4" });
    expect(n.rootView).toBe("ZI_AS_BK197");
    expect(n.projectionView).toBe("ZC_AS_BK197");
    expect(n.behaviourClass).toBe("ZBP_AS_BK197");
    expect(n.serviceDefinition).toBe("ZUI_AS_BK197");
    expect(n.serviceBinding).toBe("ZUI_AS_BK197_O4");
    expect(n.draftTable).toBe("ZAS_BK197_D");
    expect(n.alias).toBe("AsBk197");
  });

  it("suffixes the binding _O2 for OData V2", () => {
    const n = deriveRapNames(PREFIX, { bindingType: "V2" });
    expect(n.serviceBinding).toBe("ZUI_AS_BK197_O2");
  });

  it("accepts a /NS/ namespace prefix", () => {
    const n = deriveRapNames("/ABC/BK", { bindingType: "V4" });
    expect(n.rootView).toBe("/ABC/I_BK");
    expect(n.projectionView).toBe("/ABC/C_BK");
    expect(n.behaviourClass).toBe("/ABC/BP_BK");
    expect(n.serviceDefinition).toBe("/ABC/UI_BK");
    expect(n.serviceBinding).toBe("/ABC/UI_BK_O4");
    expect(n.draftTable).toBe("/ABC/BK_D");
    expect(n.alias).toBe("Bk");
  });

  it("throws BAD_INPUT for a prefix outside the customer namespace grammar", () => {
    expect(thrownCode(() => deriveRapNames("BKXYZ", { bindingType: "V4" }))).toBe("BAD_INPUT");
  });

  it("throws BAD_INPUT when a derived name exceeds its length limit", () => {
    const longStem = "A".repeat(20);
    expect(thrownCode(() => deriveRapNames(`Z${longStem}`, { bindingType: "V4" }))).toBe("BAD_INPUT");
  });

  it("an explicit override bypasses the length check for that name", () => {
    const longStem = "A".repeat(20);
    const n = deriveRapNames(`Z${longStem}`, {
      bindingType: "V4",
      names: { draft_table: "ZSHORT_D", service_binding: "ZSHORTBIND_O4" },
    });
    expect(n.draftTable).toBe("ZSHORT_D");
    expect(n.serviceBinding).toBe("ZSHORTBIND_O4");
  });
});

describe("generateRapStack — managed, no draft", () => {
  const stack = generateRapStack(baseSpec({ flavour: "managed", draft: false, includeProjection: true }));

  it("emits 8 artifacts in the documented order, no draft table", () => {
    expect(stack.artifacts.map((a) => a.key)).toEqual([
      "root_view",
      "root_behaviour",
      "projection_view",
      "projection_behaviour",
      "behaviour_class",
      "behaviour_class_local",
      "service_definition",
      "service_binding",
    ]);
  });

  it("root view lists every non-client field with a CamelCase alias", () => {
    const rootView = stack.artifacts.find((a) => a.key === "root_view")!;
    expect(rootView.source).toContain("define root view entity ZI_AS_BK197");
    expect(rootView.source).toContain("as select from zas_booking197");
    expect(rootView.source).toContain("key booking_uuid as BookingUuid");
    expect(rootView.source).toContain("customer_id as CustomerId");
    expect(rootView.source).not.toMatch(/\bmandt\b/i);
  });

  it("root BDEF carries the managed shape", () => {
    const bdef = stack.artifacts.find((a) => a.key === "root_behaviour")!;
    expect(bdef.source).toContain("managed implementation in class zbp_as_bk197 unique;");
    expect(bdef.source).toContain("persistent table zas_booking197");
    expect(bdef.source).toContain("etag master LastChangedAt");
    expect(bdef.source).toContain("field ( readonly ) BookingUuid;");
    expect(bdef.source).toContain("field ( readonly ) LastChangedAt;");
    expect(bdef.source).not.toContain("with draft");
    // Root BDEFs declare operations bare; `use create` is projection-only syntax (A4H rejects it in a root).
    expect(bdef.source).toMatch(/\n  create;\n  update;\n  delete;\n/);
    expect(bdef.source).not.toContain("use create");
    for (const alias of ["BookingUuid", "CustomerId", "BookingDate", "Amount", "CurrencyCode", "Status", "LastChangedAt"]) {
      expect(bdef.source).toContain(alias);
    }
  });
});

describe("generateRapStack — unmanaged", () => {
  const stack = generateRapStack(baseSpec({ flavour: "unmanaged", draft: false }));

  it("root BDEF has no persistent table and an unmanaged header", () => {
    const bdef = stack.artifacts.find((a) => a.key === "root_behaviour")!;
    expect(bdef.source).toContain("unmanaged implementation in class zbp_as_bk197 unique;");
    expect(bdef.source).not.toContain("persistent table");
  });

  it("local behaviour class implementation has a saver with 5 redefined methods and a create/update/delete/read/lock handler", () => {
    const local = stack.artifacts.find((a) => a.key === "behaviour_class_local")!;
    for (const method of ["create", "update", "delete", "read", "lock"]) {
      expect(local.source).toMatch(new RegExp(`METHODS ${method} FOR`, "i"));
    }
    expect(local.source).not.toContain("get_instance_authorizations");
    for (const method of ["finalize", "check_before_save", "save", "cleanup", "cleanup_finalize"]) {
      expect(local.source).toContain(`${method} REDEFINITION`);
    }
  });
});

describe("generateRapStack — draft", () => {
  const stack = generateRapStack(baseSpec({ flavour: "managed", draft: true, includeProjection: true }));

  it("emits the draft table as the first artifact", () => {
    expect(stack.artifacts[0]!.key).toBe("draft_table");
    expect(stack.artifacts[0]!.source).toContain("include sych_bdl_draft_admin_inc");
  });

  it("root BDEF carries the draft clauses", () => {
    const bdef = stack.artifacts.find((a) => a.key === "root_behaviour")!;
    expect(bdef.source).toContain("with draft;");
    expect(bdef.source).toContain("draft table zas_bk197_d");
    expect(bdef.source).toContain("total etag LastChangedAt");
    for (const action of ["Edit", "Activate", "Discard", "Resume"]) {
      expect(bdef.source).toContain(`draft action ${action};`);
    }
    expect(bdef.source).toContain("draft determine action Prepare;");
  });

  it("projection BDEF uses draft and mirrors the draft actions", () => {
    const proj = stack.artifacts.find((a) => a.key === "projection_behaviour")!;
    expect(proj.source).toContain("use draft;");
    expect(proj.source).toContain("use action Edit;");
  });
});

describe("generateRapStack — service binding version", () => {
  it("V2 binding XML carries srvb:version=\"V2\"", () => {
    const n = names("V2");
    const stack = generateRapStack(baseSpec({ names: n, bindingType: "V2" }));
    const binding = stack.artifacts.find((a) => a.key === "service_binding")!;
    expect(binding.source).toContain('srvb:version="V2"');
    expect(binding.source).toContain(`adtcore:name="${n.serviceBinding}"`);
    expect(binding.source).toContain(`adtcore:name="${PACKAGE}"`);
    expect(binding.source).toContain(`adtcore:name="${n.serviceDefinition}"`);
  });

  it("V4 binding XML carries srvb:version=\"V4\"", () => {
    const n = names("V4");
    const stack = generateRapStack(baseSpec({ names: n, bindingType: "V4" }));
    const binding = stack.artifacts.find((a) => a.key === "service_binding")!;
    expect(binding.source).toContain('srvb:version="V4"');
  });
});

describe("generateRapStack — include_projection=false", () => {
  const n = names("V4");
  const stack = generateRapStack(baseSpec({ names: n, includeProjection: false }));

  it("omits both projection artifacts", () => {
    expect(stack.artifacts.map((a) => a.key)).not.toContain("projection_view");
    expect(stack.artifacts.map((a) => a.key)).not.toContain("projection_behaviour");
  });

  it("the service definition exposes the root view directly", () => {
    const srvd = stack.artifacts.find((a) => a.key === "service_definition")!;
    expect(srvd.source).toContain(`expose ${n.rootView} as`);
  });
});

describe("generateRapStack — classic cds_form", () => {
  const stack = generateRapStack(baseSpec({ cdsForm: "classic" }));

  it("root view uses @AbapCatalog.sqlViewName and no provider contract", () => {
    const rootView = stack.artifacts.find((a) => a.key === "root_view")!;
    expect(rootView.source).toContain("@AbapCatalog.sqlViewName: 'ZIAS_BK197'");
    expect(rootView.source).toContain("define root view ZI_AS_BK197");
    expect(rootView.source).not.toContain("provider contract");
  });

  it("projection view uses its own sqlViewName and no provider contract", () => {
    const proj = stack.artifacts.find((a) => a.key === "projection_view")!;
    expect(proj.source).toContain("@AbapCatalog.sqlViewName: 'ZCAS_BK197'");
    expect(proj.source).not.toContain("provider contract");
  });
});

describe("generateRapStack — field coverage consistency", () => {
  it("every non-client field is mapped, and the client field is not", () => {
    const stack = generateRapStack(baseSpec({}));
    expect(stack.summary.allFieldsCovered).toBe(true);
    for (const f of stack.summary.fields) {
      if (f.role === "client") {
        expect(f.inView).toBe(false);
        expect(f.inMapping).toBe(false);
      } else {
        expect(f.inView).toBe(true);
        expect(f.inMapping).toBe(true);
      }
    }
    const client = stack.summary.fields.find((f) => f.name === "MANDT")!;
    expect(client.role).toBe("client");
  });
});

describe("generateRapStack — no timestamp field", () => {
  it("emits no etag master, a note about it, and stays fully covered", () => {
    const stack = generateRapStack(baseSpec({ fields: FIELDS_NO_TIMESTAMP }));
    const bdef = stack.artifacts.find((a) => a.key === "root_behaviour")!;
    expect(bdef.source).not.toContain("etag master");
    expect(stack.summary.notes.some((n) => /etag/i.test(n))).toBe(true);
    expect(stack.summary.allFieldsCovered).toBe(true);
  });
});
