/**
 * Unit tests for `src/adt/class-interfaces.ts`'s pure, no-network helpers:
 * `definitionNamePosition` (locates the class NAME token in a `CLASS <name>
 * DEFINITION` statement, for the type-hierarchy probe's `uri#start=line,col`
 * fragment), `interfacesFromDefinition` (scans the DEFINITION part only for
 * `INTERFACES` statements) and `hasMethodImplementation` (scans for a
 * `METHOD [intf~]name` statement). `fetchImplementedInterfaces` needs a live
 * `AbapConnection`/`FakeAdtServer` and is covered where it's actually
 * exercised — `test/bopf-tools.test.ts` and `test/bopf-client.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  definitionNamePosition,
  interfacesFromDefinition,
  hasMethodImplementation,
  hasImplementationPart,
} from "../src/adt/class-interfaces.js";

describe("definitionNamePosition", () => {
  it("returns the 1-based line and 0-based column of the class name", () => {
    const source = "class zcl_x definition public.\n";
    expect(definitionNamePosition(source, "zcl_x")).toEqual({
      line: 1,
      column: 6,
    });
  });

  it("is case-insensitive on the class name", () => {
    const source = "CLASS ZCL_X DEFINITION PUBLIC.\n";
    expect(definitionNamePosition(source, "zcl_x")).toEqual({
      line: 1,
      column: 6,
    });
  });

  it("a leading blank line shifts the position to line 2", () => {
    const source = "\nclass zcl_x definition public.\n";
    expect(definitionNamePosition(source, "zcl_x")).toEqual({
      line: 2,
      column: 6,
    });
  });

  it("a leading comment line shifts the position to line 2", () => {
    const source = "* a leading comment\nclass zcl_x definition public.\n";
    expect(definitionNamePosition(source, "zcl_x")).toEqual({
      line: 2,
      column: 6,
    });
  });

  it("a class name mismatch returns undefined", () => {
    const source = "class zcl_y definition public.\n";
    expect(definitionNamePosition(source, "zcl_x")).toBeUndefined();
  });
});

describe("interfacesFromDefinition", () => {
  it("a single lower-case INTERFACES statement, upper-cased in the result", () => {
    const source =
      `CLASS zcl_a DEFINITION PUBLIC.\n` +
      `  PUBLIC SECTION.\n` +
      `    interfaces /bobf/if_frw_action.\n` +
      `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source)).toEqual({
      interfaces: ["/BOBF/IF_FRW_ACTION"],
      inheriting: false,
    });
  });

  it("mixed-case keyword and interface name, with stray whitespace before the period", () => {
    const source =
      `CLASS zcl_b DEFINITION PUBLIC.\n` +
      `  PUBLIC SECTION.\n` +
      `    Interfaces /Bobf/If_Frw_Query .\n` +
      `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source).interfaces).toEqual(["/BOBF/IF_FRW_QUERY"]);
  });

  it("a chained INTERFACES: statement yields every listed name, including one with ABSTRACT METHODS", () => {
    const source =
      `CLASS zcl_c DEFINITION PUBLIC.\n` +
      `  PUBLIC SECTION.\n` +
      `    INTERFACES: if_a,\n` +
      `      if_b ABSTRACT METHODS m.\n` +
      `ENDCLASS.\n` +
      `CLASS zcl_c IMPLEMENTATION.\n` +
      `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source)).toEqual({
      interfaces: ["IF_A", "IF_B"],
      inheriting: false,
    });
  });

  it("a commented-out line and a trailing comment on a real statement are both ignored", () => {
    const source =
      `CLASS zcl_d DEFINITION PUBLIC.\n` +
      `  PUBLIC SECTION.\n` +
      `* interfaces if_c.\n` +
      `    interfaces if_e. " interfaces if_d\n` +
      `ENDCLASS.\n` +
      `CLASS zcl_d IMPLEMENTATION.\n` +
      `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source).interfaces).toEqual(["IF_E"]);
  });

  it("the IMPLEMENTATION part is not scanned — an INTERFACES-shaped line there does not count", () => {
    const source =
      `CLASS zcl_f DEFINITION PUBLIC.\n` +
      `  PUBLIC SECTION.\n` +
      `    INTERFACES if_real.\n` +
      `ENDCLASS.\n` +
      `CLASS zcl_f IMPLEMENTATION.\n` +
      `    INTERFACES if_fake.\n` +
      `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source).interfaces).toEqual(["IF_REAL"]);
  });

  it("inheriting is true when the definition part has INHERITING FROM", () => {
    const source =
      `CLASS zcl_g DEFINITION PUBLIC INHERITING FROM zcl_base.\n` +
      `ENDCLASS.\n` +
      `CLASS zcl_g IMPLEMENTATION.\n` +
      `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source)).toEqual({
      interfaces: [],
      inheriting: true,
    });
  });

  it("inheriting is false when there is no INHERITING FROM", () => {
    const source = `CLASS zcl_h DEFINITION PUBLIC.\n` + `ENDCLASS.\n` + `CLASS zcl_h IMPLEMENTATION.\n` + `ENDCLASS.\n`;
    expect(interfacesFromDefinition(source).inheriting).toBe(false);
  });
});

describe("hasMethodImplementation", () => {
  it("a METHOD statement qualified with an interface name is found", () => {
    const source = `METHOD /bobf/if_frw_query~retrieve_default_param.\nENDMETHOD.\n`;
    expect(hasMethodImplementation(source, "retrieve_default_param")).toBe(true);
  });

  it("a bare METHOD statement is found", () => {
    const source = `method retrieve_default_param.\nendmethod.\n`;
    expect(hasMethodImplementation(source, "retrieve_default_param")).toBe(true);
  });

  it("a mere mention in a comment, with no METHOD statement, is not a match", () => {
    const source = `* METHOD retrieve_default_param would go here\nMETHOD query.\nENDMETHOD.\n`;
    expect(hasMethodImplementation(source, "retrieve_default_param")).toBe(false);
  });

  it("a mere mention inside a string literal, with no METHOD statement, is not a match", () => {
    const source = `DATA(lv_text) = 'retrieve_default_param'.\n`;
    expect(hasMethodImplementation(source, "retrieve_default_param")).toBe(false);
  });

  it("is case-insensitive on both the METHOD keyword and the method name", () => {
    const source = `Method RETRIEVE_DEFAULT_PARAM.\nEndMethod.\n`;
    expect(hasMethodImplementation(source, "retrieve_default_param")).toBe(true);
  });
});

describe("hasImplementationPart", () => {
  it("a lower-case `class x implementation.` statement counts", () => {
    expect(
      hasImplementationPart("class zcl_x definition public.\nendclass.\nclass zcl_x implementation.\nendclass.\n"),
    ).toBe(true);
  });

  it("a definition-only source has no implementation part", () => {
    expect(hasImplementationPart("CLASS zcl_x DEFINITION PUBLIC.\nENDCLASS.\n")).toBe(false);
  });

  it("a commented-out implementation statement does not count", () => {
    expect(hasImplementationPart("CLASS zcl_x DEFINITION PUBLIC.\nENDCLASS.\n* CLASS zcl_x IMPLEMENTATION.\n")).toBe(
      false,
    );
  });
});
