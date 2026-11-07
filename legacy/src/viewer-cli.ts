import { ViewerData } from "./viewer-data.js";
import { createViewerServer } from "./viewer-server.js";

try {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !["--store", "--workflow", "--port"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error(
        "Usage: pnpm viewer --store <storage-directory> --workflow <workflow-id> [--port 4310]",
      );
    options.set(key, value);
  }
  const store = options.get("--store");
  const workflow = options.get("--workflow");
  const rawPort = options.get("--port") ?? "4310";
  if (
    !store ||
    !workflow ||
    !/^\d+$/.test(rawPort) ||
    Number(rawPort) < 1024 ||
    Number(rawPort) > 65535
  )
    throw new Error("Supply --store and --workflow, with an optional port from 1024–65535.");
  const data = new ViewerData(store, workflow);
  await data.history();
  const server = createViewerServer(data);
  server.on("error", (error) => {
    console.error(`Viewer could not start: ${error.message}`);
    process.exitCode = 2;
  });
  server.listen(Number(rawPort), "127.0.0.1", () =>
    console.log(
      `AbilityBench read-only viewer: http://127.0.0.1:${rawPort}\nWorkflow: ${workflow}\nNo workflows or evaluators are imported. Press Ctrl+C to stop.`,
    ),
  );
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Viewer startup failed.");
  process.exitCode = 2;
}
