// Private real-files harness, never exported or packed.
import { join } from "node:path";
import { FileArtifactStore, writeImmutable } from "../../dist/filesystem-store.js";

const [root, value] = process.argv.slice(2);
try {
  if (value === "invalid-hash") await new FileArtifactStore(root).get("../outside");
  else await writeImmutable(join(root, "slot"), Buffer.from(value), "fixture-slot");
} catch (error) {
  process.stderr.write(error.code ?? error.message);
  process.exitCode = 2;
}
