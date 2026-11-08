// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript requires dictionary index access.
import { expect, expectTypeOf, it } from "vitest";
import { createWorkflow, stage } from "../src/index.js";

it("composes ordinary typed metadata without invoking callbacks", () => {
  let calls = 0;
  const source = stage({
    id: "source",
    inputs: { prompt: "hello" },
    run: ({ inputs }) => {
      expectTypeOf(inputs.prompt).toEqualTypeOf<string>();
      calls++;
      return { count: 2 };
    },
  });
  const consumer = stage({
    id: "consumer",
    dependencies: { first: source, second: source },
    run: ({ dependencies }) => {
      expectTypeOf(dependencies.first).toEqualTypeOf<{ count: number }>();
      // @ts-expect-error Dependency output is inferred.
      const wrong: string = dependencies.first.count;
      void wrong;
      return dependencies.second.count;
    },
  });
  const workflow = createWorkflow({ id: "typed", root: process.cwd(), stages: [consumer, source] });
  expect(workflow.topologicalOrder).toEqual(["source", "consumer"]);
  expect(calls).toBe(0);
});
it("uses declaration order for available traversal ties", () => {
  const z = stage({ id: "zed", run: () => null });
  const a = stage({ id: "alpha", run: () => null });
  const child = stage({ id: "child", dependencies: { z }, run: () => null });
  expect(
    createWorkflow({ id: "ties", root: process.cwd(), stages: [child, z, a] }).topologicalOrder,
  ).toEqual(["zed", "child", "alpha"]);
});
it("accepts alias and own __proto__ bindings, rejecting foreign handles", () => {
  const source = stage({ id: "source", run: () => null });
  const consumer = stage({
    id: "consumer",
    dependencies: JSON.parse('{"__proto__":null}'),
    run: () => null,
  });
  expect(() => createWorkflow({ id: "typed", root: process.cwd(), stages: [consumer] })).toThrow();
  const aliases = stage({
    id: "aliases",
    dependencies: Object.fromEntries([
      ["__proto__", source],
      ["other", source],
    ]),
    run: () => null,
  });
  expect(
    createWorkflow({ id: "typed", root: process.cwd(), stages: [aliases, source] })
      .topologicalOrder,
  ).toEqual(["source", "aliases"]);
  expect(() => createWorkflow({ id: "typed", root: process.cwd(), stages: [aliases] })).toThrow();
});
it("rejects malformed graph and ordinary reuse metadata", () => {
  for (const id of ["", "../bad", "UPPER", "a--b"]) {
    expect(() =>
      createWorkflow({
        id: "typed",
        root: process.cwd(),
        stages: [stage({ id, run: () => null })],
      }),
    ).toThrow();
  }
  const source = stage({ id: "source", run: () => null });
  expect(() =>
    createWorkflow({ id: "typed", root: process.cwd(), stages: [source, source] }),
  ).toThrow();
  for (const environment of [["BAD-NAME"], ["X", "X"]]) {
    expect(() =>
      createWorkflow({
        id: "typed",
        root: process.cwd(),
        stages: [stage({ id: "env", environment, run: () => null })],
      }),
    ).toThrow();
  }
  for (const reuse of [{}, { revision: " " }, { files: [""] }, { files: ["a", "a"] }]) {
    expect(() =>
      createWorkflow({
        id: "typed",
        root: process.cwd(),
        stages: [stage({ id: "invalid", reuse, run: () => null })],
      }),
    ).toThrow();
  }
  for (const reuse of [{ revision: "v1" }, { files: ["source.ts"] }]) {
    expect(() =>
      createWorkflow({
        id: "typed",
        root: process.cwd(),
        stages: [stage({ id: "valid", reuse, run: () => null })],
      }),
    ).not.toThrow();
  }
});
it("rejects self dependencies, cycles, forged handles and empty bindings", () => {
  const deps: Record<string, ReturnType<typeof stage>> = {};
  const left = stage({ id: "left", dependencies: deps, run: () => null });
  deps["self"] = left;
  expect(() => createWorkflow({ id: "graph", root: process.cwd(), stages: [left] })).toThrow();
  const right = stage({ id: "right", dependencies: { left }, run: () => null });
  deps["self"] = right;
  expect(() =>
    createWorkflow({ id: "graph", root: process.cwd(), stages: [left, right] }),
  ).toThrow();
  expect(() =>
    createWorkflow({ id: "graph", root: process.cwd(), stages: [{ id: "fake" }] }),
  ).toThrow();
  const empty = stage({ id: "empty", dependencies: { "": right }, run: () => null });
  expect(() =>
    createWorkflow({ id: "graph", root: process.cwd(), stages: [empty, right] }),
  ).toThrow();
});
it("rejects malformed JavaScript metadata without coercion", () => {
  for (const overrides of [
    { inputs: null },
    { inputs: [] },
    { inputs: 4 },
    { reuse: null },
    { reuse: true },
    { reuse: { files: "source.ts" } },
    { environment: "NAME" },
    { dependencies: [] },
  ]) {
    // @ts-expect-error Deliberately exercise malformed JavaScript callers.
    const bad = stage({ id: "bad", run: () => null, ...overrides });
    expect(() => createWorkflow({ id: "typed", root: process.cwd(), stages: [bad] })).toThrowError(
      expect.objectContaining({ code: "invalid_declaration" }),
    );
  }
});
it("rejects sparse declaration lists and attributes strict input errors", () => {
  for (const overrides of [
    { environment: new Array<string>(1) },
    { reuse: { files: new Array<string>(1) } },
  ]) {
    const bad = stage({ id: "bad", run: () => null, ...overrides });
    expect(() => createWorkflow({ id: "graph", root: process.cwd(), stages: [bad] })).toThrowError(
      expect.objectContaining({ code: "invalid_declaration" }),
    );
  }
  const bad = stage({ id: "bad", inputs: { "a/b~": Number.NaN }, run: () => null });
  expect(() => createWorkflow({ id: "graph", root: process.cwd(), stages: [bad] })).toThrowError(
    expect.objectContaining({ code: "invalid_json_value", stageId: "bad", path: "/a~1b~0" }),
  );
});
