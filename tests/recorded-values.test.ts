import { expect, it } from "vitest";
import { copyValue, orderedJson } from "../src/recorded-values.js";

it.each([
  undefined,
  () => null,
  Symbol(),
  1n,
  NaN,
  Infinity,
  -Infinity,
  -0,
  Array(1),
  new Date(),
  new Map(),
  Object.assign([1], { extra: 1 }),
  { [Symbol()]: 1 },
  Object.defineProperty({}, "hidden", { value: 1 }),
  Object.create({ inherited: 1 }),
])("rejects unsupported strict values %s", (value) => {
  expect(() => copyValue({ "a~/": value })).toThrowError(
    expect.objectContaining({
      code: "invalid_json_value",
      path: expect.stringContaining("/a~0~1"),
    }),
  );
});
it("does not invoke getters or toJSON and detects recursion ancestors", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  expect(() => copyValue(getter)).toThrowError(expect.objectContaining({ path: "/x" }));
  expect(() =>
    copyValue({
      toJSON() {
        calls++;
        return {};
      },
    }),
  ).toThrow();
  expect(calls).toBe(0);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(() => copyValue(cycle)).toThrowError(expect.objectContaining({ path: "/self" }));
});
it("copies repeated acyclic references independently and preserves integer key order and lone surrogates", () => {
  const shared = { z: [3, 1], a: "\ud800" };
  const value = Object.assign(Object.create(null), {
    b: shared,
    a: shared,
    9: "nine",
    2: "two",
    "\udfff": "ok",
  });
  const result = copyValue(value) as { b: { z: number[] }; a: { z: number[] } };
  expect(Object.keys(result)).toEqual(["2", "9", "b", "a", "\udfff"]);
  result.b.z.sort();
  expect(result.a.z).toEqual([3, 1]);
  expect(shared.z).toEqual([3, 1]);
  expect(orderedJson({ "\ud800": "\udfff" })).toBe('{"\\ud800":"\\udfff"}');
});
