import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  createArtifact,
  decodeArtifact,
  type SerializationError,
} from "../src/serialization.js";

describe("canonical JSON", () => {
  it.each([
    undefined,
    () => null,
    Symbol("value"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    new Date(0),
    new Map(),
    Array(1),
  ])("rejects unsupported values without coercion: %s", (value) => {
    expect(() => canonicalizeJson(value)).toThrow();
  });

  it("rejects cycles, symbol keys and extra array properties", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalizeJson(cycle)).toThrow();
    expect(() => canonicalizeJson({ [Symbol("key")]: 1 })).toThrow();
    expect(() => canonicalizeJson(Object.assign([1], { extra: true }))).toThrow();
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
