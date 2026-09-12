/**
 * Cloud-tenant recognition for `SystemRoleDetection.tenantKind` (issue #80).
 *
 * `tenantKind` records whether `ato/settings` looks like it answered from a
 * cloud tenant (SAP BTP ABAP environment / steampunk, `operationsType="C"`)
 * or an on-premise/hybrid one (`operationsType="H"`). The one rule this file
 * exists to enforce end to end: that observation is read-only. It rides along
 * on the SAME `ato/settings` response `escalateIfAtoSaysProductive` already
 * fetches for the one-way productive escalation — no new HTTP call — and it
 * must never feed `role`, in either direction. See the doc on
 * `SystemRoleDetection.tenantKind` in `src/adt/system-role.ts` and
 * `doc/SAFETY/safety-gate.md`.
 *
 * Harness style matches `test/role-probe-transport-failure.test.ts`: drive
 * `detectSystemRole()` directly with a hand-built `SystemRoleProbes` double,
 * skipping `AbapConnection`/the wire entirely, since this module's own seam
 * is exactly that interface.
 */
import { describe, expect, it } from "vitest";
import { detectSystemRole, type SystemRoleProbes } from "../src/adt/system-role.js";

/**
 * Every collaborator defaults to a loud throw rather than a silent resolve,
 * so a test that forgets to stub a probe fails with a clear message instead
 * of quietly passing on default data.
 */
function fakeProbes(overrides: Partial<SystemRoleProbes> = {}): SystemRoleProbes {
  return {
    probeT000: async () => {
      throw new Error("fakeProbes: probeT000 was not stubbed for this test");
    },
    getAtoSettings: async () => {
      throw new Error("fakeProbes: getAtoSettings was not stubbed for this test");
    },
    cookies: () => null,
    assertBreakerClosed: () => {},
    log: () => {},
    ...overrides,
  };
}

/** Minimal column-major T000 data-preview document, one row, for the given client/category. */
function t000Body(client: string, cccategory: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT"/><dataPreview:dataSet>` +
    `<dataPreview:data>${client}</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="CCCATEGORY"/><dataPreview:dataSet>` +
    `<dataPreview:data>${cccategory}</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
    `</dataPreview:tableData>`
  );
}

const t000 = (client: string, cccategory: string) => ({
  status: 200,
  body: t000Body(client, cccategory),
  headers: {},
});

/** `ato/settings` body with the given attributes, XML-attribute style, matching the real wire shape. */
const atoSettings = (attrs: Record<string, string>): { status: number; body: string; headers: Record<string, unknown> } => ({
  status: 200,
  body: `<settings ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}/>`,
  headers: {},
});

const CLIENT = "001";
const cfg = { client: CLIENT };

describe("SystemRoleDetection.tenantKind — an observation, never an input to role", () => {
  it('operationsType="C" in ato/settings is recorded as tenantKind cloud', async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "C"), // nonproductive
      getAtoSettings: async () => atoSettings({ operationsType: "C" }),
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("nonproductive");
    expect(detection.tenantKind).toBe("cloud");
  });

  it('operationsType="H" is recorded as tenantKind on-premise', async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "C"),
      getAtoSettings: async () => atoSettings({ operationsType: "H" }),
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("nonproductive");
    expect(detection.tenantKind).toBe("on-premise");
  });

  it("an absent operationsType leaves tenantKind unknown", async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "C"),
      getAtoSettings: async () => atoSettings({ isExtendedInboundServices: "true" }),
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("nonproductive");
    expect(detection.tenantKind).toBe("unknown");
  });

  it("an unrecognised operationsType value leaves tenantKind unknown, not cloud", async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "C"),
      getAtoSettings: async () => atoSettings({ operationsType: "X" }),
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("nonproductive");
    expect(detection.tenantKind).toBe("unknown");
    expect(detection.tenantKind).not.toBe("cloud");
  });

  // THE regression guard for the one rule this feature must never break:
  // a cloud observation is not evidence of anything about `role`, and it must
  // never open a path from a T000-proven-productive verdict to anything else.
  it("a cloud tenant is NOT downgraded to nonproductive", async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "P"), // productive
      getAtoSettings: async () => atoSettings({ operationsType: "C" }),
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("productive");
  });

  it('a cloud tenant whose ato/settings says isProductionSystem="true" still escalates to productive', async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "C"), // T000 alone says nonproductive
      getAtoSettings: async () => atoSettings({ operationsType: "C", isProductionSystem: "true" }),
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("productive");
    expect(detection.tenantKind).toBe("cloud");
  });

  it("a failed ato/settings probe leaves tenantKind unknown and the role untouched", async () => {
    const probes = fakeProbes({
      probeT000: async () => t000(CLIENT, "C"),
      getAtoSettings: async () => {
        throw new Error("ato/settings unreachable");
      },
    });

    const detection = await detectSystemRole(probes, cfg);

    expect(detection.role).toBe("nonproductive");
    expect(detection.tenantKind).toBe("unknown");
  });
});
