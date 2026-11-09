import { cp, rename } from "node:fs/promises";
import { join } from "node:path";

export const phase0Id = "run_2614c7ad7552d7958bde8eb1dc596ba031716de5d34f87f232d93facdd19186a";
export const phase0Artifact = "c922ac2dd3a1836e6001f91ca4aa630ad8d6000a8a4eb52320e27fefb2d17665";

// Unmodified bytes saved once with the frozen Phase 0 planner, executor and file stores.
// Deliberately retain only the failed child and its reused source artifact.
export async function copyPhase0History(destination: string): Promise<void> {
  await cp(new URL("./phase0-history/", import.meta.url), destination, { recursive: true });
  // Use a non-JSON fixture extension to keep formatters away from hashed bytes.
  await rename(
    join(destination, "runs", `${phase0Id}.bytes`),
    join(destination, "runs", `${phase0Id}.json`),
  );
}
