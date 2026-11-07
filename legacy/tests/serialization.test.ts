import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  createArtifact,
  decodeArtifact,
  type SerializationError,
} from "../src/index.js";

describe("canonical JSON", () => {
  it("orders object keys while preserving array order", () => {
    const left = { z: 1, a: { y: true, x: [3, 2, 1] } };
    const right = { a: { x: [3, 2, 1], y: true }, z: 1 };

    expect(canonicalizeJson(left)).toBe('{"a":{"x":[3,2,1],"y":true},"z":1}');
    expect(canonicalizeJson(right)).toBe(canonicalizeJson(left));
    expect(createArtifact(right).contentHash).toBe(createArtifact(left).contentHash);
  });

  it.each([
    ["undefined", undefined, "unsupported_type"],
    ["bigint", 1n, "unsupported_type"],
    ["NaN", Number.NaN, "invalid_number"],
    ["infinity", Number.POSITIVE_INFINITY, "invalid_number"],
    ["negative zero", -0, "invalid_number"],
    ["date", new Date(0), "custom_prototype"],
    ["array subclass", new (class extends Array {})(), "custom_prototype"],
    ["sparse array", Array(1), "sparse_array"],
    ["unpaired surrogate", "\ud800", "invalid_unicode"],
  ])("rejects %s", (_label, value, code) => {
    expect(() => canonicalizeJson(value)).toThrowError(
      expect.objectContaining<Partial<SerializationError>>({
        code: code as SerializationError["code"],
      }),
    );
  });

  it("rejects cycles and shared object references", () => {
    const shared = { value: true };
    expect(() => canonicalizeJson({ first: shared, second: shared })).toThrowError(
      expect.objectContaining<Partial<SerializationError>>({
        code: "shared_reference",
        path: "$/second",
      }),
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrowError(
      expect.objectContaining<Partial<SerializationError>>({ code: "shared_reference" }),
    );
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "unsafe";
      },
    });

    expect(() => canonicalizeJson(value)).toThrowError(
      expect.objectContaining<Partial<SerializationError>>({ code: "accessor_property" }),
    );
    expect(invoked).toBe(false);
  });

  it("rejects non-enumerable array elements", () => {
    const value = Object.defineProperty([1], "0", { enumerable: false });
    expect(() => canonicalizeJson(value)).toThrowError(
      expect.objectContaining<Partial<SerializationError>>({
        code: "non_enumerable_property",
        path: "$/0",
      }),
    );
  });
});

describe("artifact envelopes", () => {
  it("round-trips canonical JSON after verifying integrity", () => {
    const artifact = createArtifact({ valid: true, count: 3 });

    expect(artifact.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifact.byteLength).toBe(24);
    expect(decodeArtifact(artifact)).toEqual({ count: 3, valid: true });
  });

  it("rejects modified artifact bytes", () => {
    const artifact = createArtifact({ valid: true });
    const corrupted = {
      ...artifact,
      payload: new TextEncoder().encode('{"valid":false}'),
      byteLength: new TextEncoder().encode('{"valid":false}').byteLength,
    };

    expect(() => decodeArtifact(corrupted)).toThrow("Artifact content hash does not match");
  });

  it("rejects noncanonical JSON even when its byte hash matches", () => {
    const payload = new TextEncoder().encode('{"b":2,"a":1}');
    const digest = createHash("sha256")
      .update("abilitybench/artifact/v1\0")
      .update(payload)
      .digest("hex");
    expect(() =>
      decodeArtifact({
        schemaVersion: "phase0-artifact-v1",
        codec: "canonical-json-v1",
        contentHash: `sha256:${digest}`,
        byteLength: payload.byteLength,
        payload,
      }),
    ).toThrow("not canonical JSON");
  });
});
