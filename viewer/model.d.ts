import type { RunManifestStage } from "../src/run-manifest.js";

export function status(stage: RunManifestStage): string;
export function explanation(stage: RunManifestStage): string;
export function layout(stages: RunManifestStage[]): {
  nodes: { stage: RunManifestStage; x: number; y: number }[];
  width: number;
  height: number;
};
export const COMPONENTS: readonly (readonly [
  keyof import("../src/fingerprint.js").FingerprintComponentHashes,
  string,
])[];
