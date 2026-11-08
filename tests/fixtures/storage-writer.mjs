// Private process harness, never exported or packed.
import { createHash } from "node:crypto";
import { publish } from "../../dist/filesystem-store.js";

const [root, payload, mode] = process.argv.slice(2);
const header = "abilitybench-artifact-v2\nordered-json-v1\nsha256-domain-v2\n";
const bytes = Buffer.from(header + payload);
const hash =
  "sha256:" + createHash("sha256").update("abilitybench/artifact/v2\0").update(bytes).digest("hex");
try {
  await publish(
    root,
    {
      kind: "artifact",
      identity: mode === "invalid" ? "../outside" : hash,
      bytes,
      reference: {
        artifactSchema: "abilitybench-artifact-v2",
        codec: "ordered-json-v1",
        hashScheme: "sha256-domain-v2",
        hash,
        byteLength: Buffer.byteLength(payload),
        observedAt: "2026-11-08T00:00:00.000Z",
        origin: { attemptId: "12345678-1234-4234-8234-123456789abc", stageId: "stage" },
      },
    },
    mode === "pause"
      ? {
          locked: async () => {
            process.stdout.write("locked\n");
            await new Promise((resolve) => process.stdin.once("data", resolve));
            process.stdin.destroy();
          },
        }
      : {},
  );
} catch (error) {
  process.stderr.write(error.code ?? error.message);
  process.exitCode = 2;
}
