import { describe, expect, it } from "vitest";

import { ABILITYBENCH_CONTRACT_VERSION } from "../src/index.js";

describe("package contract", () => {
  it("exposes the active execution contract version", () => {
    expect(ABILITYBENCH_CONTRACT_VERSION).toBe("phase0-v1");
  });
});
