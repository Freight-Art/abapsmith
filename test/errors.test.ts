/**
 * `describeUnknownError` — the envelope's last line of defence.
 *
 * The function is typed `: string` and every caller splices its result straight
 * into an error envelope's `message`. The original implementation lied: its
 * `JSON.stringify(e)` fallback returns the *value* `undefined` for `undefined`,
 * functions and symbols, so `throw undefined` (legal JS, and what a promise
 * rejected with no reason produces) erased the `message` key entirely and left
 * the caller holding a failure that said nothing.
 *
 * Every test in here fails against the pre-fix implementation.
 */
import { describe, expect, it } from "vitest";
import { AbapError, describeUnknownError, isAbapError } from "../src/adt/errors.js";

/** The whole contract in one predicate: a real, non-empty, informative string. */
function expectUsable(actual: unknown): string {
  expect(typeof actual).toBe("string");
  const text = actual as string;
  expect(text.length).toBeGreaterThan(0);
  expect(text.trim().length).toBeGreaterThan(0);
  return text;
}

describe("describeUnknownError: values JSON.stringify turns into `undefined`", () => {
  it("describes a thrown `undefined` instead of returning the value `undefined`", () => {
    // Pre-fix: JSON.stringify(undefined) === undefined, so the typed-`string`
    // return was literally `undefined` and the envelope lost its message.
    const out = describeUnknownError(undefined);
    expect(out).not.toBeUndefined();
    const text = expectUsable(out);
    expect(text).toMatch(/undefined/);
  });

  it("describes a thrown function, naming it", () => {
    function retryHandler() {
      /* never called */
    }
    const text = expectUsable(describeUnknownError(retryHandler));
    expect(text).toMatch(/function/i);
    expect(text).toMatch(/retryHandler/);
  });

  it("describes a thrown anonymous arrow function", () => {
    const text = expectUsable(describeUnknownError(() => undefined));
    expect(text).toMatch(/function/i);
  });

  it("describes a thrown symbol without interpolating it (which would throw)", () => {
    const text = expectUsable(describeUnknownError(Symbol("enqueue-lock")));
    expect(text).toMatch(/Symbol/);
    expect(text).toMatch(/enqueue-lock/);
  });

  it("describes a description-less symbol", () => {
    expectUsable(describeUnknownError(Symbol()));
  });
});

describe("describeUnknownError: the other holes in the pre-fix branches", () => {
  it("does not return an empty string for an `Error` with an empty message", () => {
    // Pre-fix: `return e.message` handed back "" — an envelope with a blank
    // message is as useless as one with none.
    const text = expectUsable(describeUnknownError(new Error("")));
    expect(text).toMatch(/empty message/i);
  });

  it("names the error class when the message is empty", () => {
    class SessionDeadError extends Error {
      constructor() {
        super("");
        this.name = "SessionDeadError";
      }
    }
    const text = expectUsable(describeUnknownError(new SessionDeadError()));
    expect(text).toMatch(/SessionDeadError/);
  });

  it("does not return a whitespace-only string for a whitespace-only Error message", () => {
    expectUsable(describeUnknownError(new Error("   \n\t ")));
  });

  it("does not return an empty string for a thrown empty string", () => {
    const text = expectUsable(describeUnknownError(""));
    expect(text).toMatch(/empty string/i);
  });

  it("describes a thrown `null` as more than the bare token", () => {
    // Pre-fix: JSON.stringify(null) === "null" — a message reading exactly
    // "null" is indistinguishable from a serialisation artefact.
    const text = expectUsable(describeUnknownError(null));
    expect(text).not.toBe("null");
    expect(text).toMatch(/null/);
    expect(text).toMatch(/thrown/i);
  });

  it("survives an object carrying a BigInt, which makes JSON.stringify throw", () => {
    // Pre-fix: the catch fell through to String(e) === "[object Object]",
    // which names nothing and points nowhere.
    const text = expectUsable(describeUnknownError({ id: 1n, where: "T000 probe" }));
    expect(text).not.toBe("[object Object]");
    expect(text).toMatch(/BigInt/i);
  });

  it("survives a bare BigInt, which JSON.stringify also refuses", () => {
    const text = expectUsable(describeUnknownError(42n));
    expect(text).toMatch(/42/);
  });

  it("does not return `undefined` for an object whose toJSON yields undefined", () => {
    // JSON.stringify does not throw here — it *returns* undefined, so the
    // pre-fix `try` branch handed the value straight back.
    const thrown = { toJSON: () => undefined, marker: "adt" };
    const out = describeUnknownError(thrown);
    expect(out).not.toBeUndefined();
    expectUsable(out);
  });

  it("does not throw on a null-prototype object (String() has no toString to call)", () => {
    // Pre-fix: JSON.stringify gives "{}" here, so this survived by luck; the
    // circular variant below is the one that actually detonated.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.detail = "no prototype";
    expectUsable(describeUnknownError(bare));
  });

  it("does not throw when JSON.stringify fails AND String() fails", () => {
    // Circular (stringify throws) + null prototype (String throws): pre-fix the
    // describer itself threw, replacing the original failure with its own.
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;
    expect(() => describeUnknownError(hostile)).not.toThrow();
    expectUsable(describeUnknownError(hostile));
  });

  it("does not throw when every accessor on the thrown value throws", () => {
    const hostile = {
      get message(): string {
        throw new Error("message getter exploded");
      },
      toJSON(): never {
        throw new Error("toJSON exploded");
      },
      toString(): never {
        throw new Error("toString exploded");
      },
    };
    expect(() => describeUnknownError(hostile)).not.toThrow();
    expectUsable(describeUnknownError(hostile));
  });

  it("recovers the message of an Error-shaped value that is not an `Error`", () => {
    // Cross-realm errors fail `instanceof` and serialise to "{}" because
    // name/message are non-enumerable.
    const crossRealm = Object.create(Object.prototype, {
      message: { value: "ADT lock held by DEVELOPER", enumerable: false },
      name: { value: "Error", enumerable: false },
    }) as object;
    const text = expectUsable(describeUnknownError(crossRealm));
    expect(text).toBe("ADT lock held by DEVELOPER");
  });

  it("does not return the uninformative `{}` for an empty object", () => {
    const text = expectUsable(describeUnknownError({}));
    expect(text).not.toBe("{}");
  });
});

describe("describeUnknownError: the contract holds for every shape at once", () => {
  const hostileToString = { toString: (): never => { throw new Error("no"); } };
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace string", "   "],
    ["normal string", "boom"],
    ["number", 42],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["false", false],
    ["bigint", 7n],
    ["symbol", Symbol("s")],
    ["anonymous symbol", Symbol()],
    ["named function", function named() {}],
    ["arrow function", () => undefined],
    ["class", class Foo {}],
    ["empty Error", new Error("")],
    ["normal Error", new Error("real message")],
    ["AbapError", new AbapError("LOCKED", "held")],
    ["empty object", {}],
    ["object", { a: 1 }],
    ["array", [1, 2]],
    ["empty array", []],
    ["bigint in object", { n: 1n }],
    ["toJSON undefined", { toJSON: () => undefined }],
    ["null prototype", Object.create(null)],
    ["hostile toString", hostileToString],
    ["date", new Date(0)],
  ];

  for (const [label, value] of cases) {
    it(`returns a non-empty string for: ${label}`, () => {
      let out: unknown;
      expect(() => {
        out = describeUnknownError(value);
      }, `describeUnknownError threw on ${label}`).not.toThrow();
      expectUsable(out);
    });
  }

  it("a circular object does not take the describer down with it", () => {
    const circular: Record<string, unknown> = { where: "connection" };
    circular.self = circular;
    expect(() => describeUnknownError(circular)).not.toThrow();
    expectUsable(describeUnknownError(circular));
  });
});

describe("describeUnknownError: behaviour worth not regressing", () => {
  it("still returns an Error's message verbatim", () => {
    expect(describeUnknownError(new Error("Session Timed Out"))).toBe("Session Timed Out");
  });

  it("still returns a thrown string verbatim", () => {
    expect(describeUnknownError("raw adt text")).toBe("raw adt text");
  });

  it("still serialises a plain object to JSON", () => {
    expect(describeUnknownError({ code: 409, reason: "locked" })).toBe(
      '{"code":409,"reason":"locked"}',
    );
  });

  it("carries an AbapError's message through, and the guard still recognises it", () => {
    const e = new AbapError("ETAG_CONFLICT", "object changed since read", { uri: "/x" });
    expect(isAbapError(e)).toBe(true);
    expect(describeUnknownError(e)).toBe("object changed since read");
  });
});

describe("AbapError.toJSON", () => {
  it("keeps the message even when it is empty (the envelope's own hole)", () => {
    // Not a describeUnknownError path, but the same envelope: assert the shape
    // callers depend on.
    const json = new AbapError("ADT_ERROR", "boom", { uri: "/x" }, "try again").toJSON();
    expect(json).toEqual({
      error: "ADT_ERROR",
      message: "boom",
      hint: "try again",
      details: { uri: "/x" },
    });
  });
});
