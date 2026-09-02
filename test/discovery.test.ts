/**
 * Discovery / release gating ("feature-probe via discovery").
 *
 * An empty inventory, a failed probe and "this release genuinely lacks the
 * collection" are three different answers. They must never collapse into a
 * single quiet `false`, because that turns one network hiccup into "this
 * system supports nothing".
 */
import type { AdtDiscoveryResult } from "abap-adt-api";
import { describe, expect, it } from "vitest";
import { Discovery } from "../src/adt/discovery.js";
import { isAbapError } from "../src/adt/errors.js";

/** Minimal shape of the Atom service document the probe parses. */
function doc(hrefs: string[]): AdtDiscoveryResult[] {
  return [
    {
      title: "ABAP Repository",
      collection: hrefs.map((href) => ({ href, title: href, templateLinks: [] })),
    },
  ] as unknown as AdtDiscoveryResult[];
}

const clientReturning = (raw: AdtDiscoveryResult[]) =>
  ({ adtDiscovery: async () => raw }) as never;

const clientFailing = (msg: string) =>
  ({
    adtDiscovery: async () => {
      throw new Error(msg);
    },
  }) as never;

describe("Discovery — never loaded is not 'unsupported'", () => {
  it("reports state 'never' before any probe", () => {
    const d = new Discovery(clientReturning(doc([])));
    expect(d.loadState).toBe("never");
    expect(d.isLoaded).toBe(false);
  });

  it("answers 'unknown', never a quiet false", () => {
    const d = new Discovery(clientReturning(doc([])));
    expect(d.capability("atc")).toBe("unknown");
  });

  it("refuses to answer supports() rather than lying", () => {
    const d = new Discovery(clientReturning(doc([])));
    let threw: unknown;
    try {
      d.supports("atc");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(isAbapError(threw)).toBe(true);
    expect(String((threw as Error).message)).toMatch(/never ran/);
  });

  it("fails open for gating helpers when the inventory is unknown", () => {
    const d = new Discovery(clientReturning(doc([])));
    expect(d.maySupport("atc")).toBe(true);
    expect(() => d.assertSupported("atc")).not.toThrow();
  });
});

describe("Discovery — a failed probe stays marked failed", () => {
  it("records the error and rethrows", async () => {
    const d = new Discovery(clientFailing("ECONNRESET"));
    await expect(d.load()).rejects.toThrow(/ECONNRESET/);
    expect(d.loadState).toBe("failed");
    expect(d.isLoaded).toBe(false);
    expect(d.error).toMatch(/ECONNRESET/);
  });

  it("still refuses to call the feature unsupported", async () => {
    const d = new Discovery(clientFailing("ECONNRESET"));
    await d.load().catch(() => undefined);
    expect(d.capability("atc")).toBe("unknown");
    expect(() => d.supports("atc")).toThrow(/failed/);
    expect(d.maySupport("atc")).toBe(true);
  });

  it("tryLoad reports false instead of throwing", async () => {
    const d = new Discovery(clientFailing("boom"));
    expect(await d.tryLoad()).toBe(false);
    expect(d.loadState).toBe("failed");
  });

  it("an empty document is 'empty', not a release without features", async () => {
    const d = new Discovery(clientReturning(doc([])));
    await d.load();
    expect(d.loadState).toBe("empty");
    expect(d.capability("atc")).toBe("unknown");
    expect(() => d.supports("atc")).toThrow(/empty inventory/);
  });
});

describe("Discovery — a successful probe answers honestly", () => {
  const loaded = async () => {
    const d = new Discovery(
      clientReturning(
        doc([
          "/sap/bc/adt/oo/classes",
          "/sap/bc/adt/ddic/tables",
          "/sap/bc/adt/repository/informationsystem/search",
        ]),
      ),
    );
    await d.load();
    return d;
  };

  it("marks a present collection supported", async () => {
    const d = await loaded();
    expect(d.loadState).toBe("loaded");
    expect(d.isLoaded).toBe(true);
    expect(d.capability("repository.search")).toBe("supported");
    expect(d.supports("repository.search")).toBe(true);
  });

  it("marks an absent collection UNSUPPORTED — and does not throw", async () => {
    const d = await loaded();
    expect(d.capability("atc")).toBe("unsupported");
    expect(d.supports("atc")).toBe(false);
    expect(d.maySupport("atc")).toBe(false);
    expect(() => d.assertSupported("atc", "ATC checks")).toThrow(/does not expose ATC checks/);
  });

  it("distinguishes loaded-and-absent from never-loaded", async () => {
    const loadedD = await loaded();
    const cold = new Discovery(clientReturning(doc([])));
    expect(loadedD.capability("atc")).toBe("unsupported");
    expect(cold.capability("atc")).toBe("unknown");
    expect(loadedD.capability("atc")).not.toBe(cold.capability("atc"));
    expect(() => loadedD.supports("atc")).not.toThrow();
    expect(() => cold.supports("atc")).toThrow();
  });

  it("summary carries the state so an empty feature list is readable", async () => {
    const d = await loaded();
    expect(d.summary().state).toBe("loaded");
    expect(new Discovery(clientReturning(doc([]))).summary().state).toBe("never");
    expect(d.summary().features).toContain("repository.search");
  });

  it("reloading after a failure recovers", async () => {
    const d = new Discovery(clientFailing("boom"));
    await d.tryLoad();
    expect(d.loadState).toBe("failed");
    d.ingest(doc(["/sap/bc/adt/atc/runs"]));
    expect(d.loadState).toBe("loaded");
    expect(d.supports("atc")).toBe(true);
  });
});

/**
 * The declared per-collection, per-verb enhancement capability table.
 * This is a static table, never a live probe (OPTIONS is refused
 * system-wide on this release), so these tests pin the declared verdicts
 * rather than any network behaviour.
 */
describe("Discovery — enhancement capability table", () => {
  const withEnhancements = async () => {
    const d = new Discovery(
      clientReturning(
        doc([
          "/sap/bc/adt/enhancements/enhoxh",
          "/sap/bc/adt/enhancements/enhoxhh",
          "/sap/bc/adt/enhancements/enhsxs",
        ]),
      ),
    );
    await d.load();
    return d;
  };

  it("refuses (unknown) before discovery has loaded, rather than guessing", () => {
    const d = new Discovery(clientReturning(doc([])));
    expect(d.enhancementCapability("enhoxh", "GET")).toEqual({
      status: "unknown",
      reason: expect.stringMatching(/never ran/),
    });
    // Unlike assertSupported()'s fail-open gate, assertEnhancementCapable()
    // refuses on `unknown` too -- an unknown combination is a
    // refusal, not a green light, because a wrong write here can dump the
    // server or kill the session.
    expect(() => d.assertEnhancementCapable("enhoxh", "GET")).toThrow(/never ran/);
  });

  it("refuses (unknown) a collection discovery does not list, even though the table has a verdict for it", async () => {
    const d = new Discovery(clientReturning(doc(["/sap/bc/adt/oo/classes"])));
    await d.load();
    expect(d.enhancementCapability("enhoxh", "GET").status).toBe("unknown");
    expect(() => d.assertEnhancementCapable("enhoxh", "GET")).toThrow(
      /not present in this system's discovery inventory/,
    );
  });

  it("refuses (unknown) a collection the table has no declared entry for, even if discovery lists it", async () => {
    const d = new Discovery(clientReturning(doc(["/sap/bc/adt/enhancements/enhoxhb"])));
    await d.load();
    expect(d.enhancementCapability("enhoxhb", "GET").status).toBe("unknown");
    expect(() => d.assertEnhancementCapable("enhoxhb", "GET")).toThrow(
      /no declared capability entry/,
    );
  });

  it("enhoxh (BAdI implementation): read/write/activate/delete supported, create refused", async () => {
    const d = await withEnhancements();
    expect(d.enhancementCapability("enhoxh", "GET")).toEqual({ status: "supported" });
    expect(d.enhancementCapability("enhoxh", "PUT")).toEqual({ status: "supported" });
    expect(d.enhancementCapability("enhoxh", "activate")).toEqual({ status: "supported" });
    expect(d.enhancementCapability("enhoxh", "DELETE")).toEqual({ status: "supported" });
    const post = d.enhancementCapability("enhoxh", "POST");
    expect(post.status).toBe("unsupported");
    expect(() => d.assertEnhancementCapable("enhoxh", "POST")).toThrow(
      /does not support method POST/,
    );
  });

  it("enhoxhh (source-code plug-in): the only collection where POST is supported", async () => {
    const d = await withEnhancements();
    expect(d.enhancementCapability("enhoxhh", "POST")).toEqual({ status: "supported" });
    expect(() => d.assertEnhancementCapable("enhoxhh", "POST")).not.toThrow();
  });

  it("enhsxs (enhancement spot): create is dangerous, not merely unsupported", async () => {
    const d = await withEnhancements();
    expect(d.enhancementCapability("enhsxs", "GET")).toEqual({ status: "supported" });
    const post = d.enhancementCapability("enhsxs", "POST");
    expect(post.status).toBe("dangerous");
    if (post.status === "dangerous") {
      expect(post.reason).toMatch(/Session Timed Out/);
    }
    let threw: unknown;
    try {
      d.assertEnhancementCapable("enhsxs", "POST");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(isAbapError(threw)).toBe(true);
    expect((threw as { details?: { status?: string } }).details?.status).toBe("dangerous");
    expect(String((threw as Error).message)).toMatch(/MUST NEVER be attempted|dangerous/i);
  });
});
