#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AbilityBenchError } from "./errors.js";
import { openHistory } from "./history.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
function usage(message: string): never {
  throw new AbilityBenchError("invalid_argument", message, "cli");
}
try {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(
      "abilitybench runs [--workflow id] [--limit n]\nabilitybench inspect run\nabilitybench output run stage\nabilitybench compare run-a run-b stage\nAll commands: --history directory --json\n",
    );
  } else if (args.length === 1 && args[0] === "--version")
    process.stdout.write(
      `${JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version}\n`,
    );
  else {
    const command = args.shift();
    if (!command || !["runs", "inspect", "output", "compare"].includes(command))
      usage("Expected runs, inspect, output or compare.");
    const positional: string[] = [];
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      if (options.has(arg)) usage(`Duplicate option ${arg}.`);
      if (arg === "--json") {
        options.set(arg, "true");
        continue;
      }
      if (!["--history", ...(command === "runs" ? ["--workflow", "--limit"] : [])].includes(arg))
        usage(`Unknown option ${arg}.`);
      const value = args[++i];
      if (!value || value.startsWith("--")) usage(`Missing value for ${arg}.`);
      options.set(arg, value);
    }
    const count = { runs: 0, inspect: 1, output: 2, compare: 3 }[command];
    if (positional.length !== count) usage("Incorrect command arguments.");
    const history = openHistory(options.get("--history") ?? resolve(".abilitybench"));
    let result: unknown;
    switch (command) {
      case "runs": {
        const raw = options.get("--limit");
        if (raw !== undefined && !/^[1-9][0-9]*$/.test(raw))
          usage("Limit must be a positive integer up to 1000.");
        result = await history.runs({
          ...(options.has("--workflow") ? { workflowId: options.get("--workflow") as string } : {}),
          ...(raw !== undefined ? { limit: Number(raw) } : {}),
        });
        break;
      }
      case "inspect":
        result = await history.run(positional[0] as string);
        break;
      case "output":
        result = await history.output(positional[0] as string, positional[1] as string);
        break;
      case "compare": {
        const comparison = await history.compare(
          positional[0] as string,
          positional[1] as string,
          positional[2] as string,
        );
        result = comparison;
        process.exitCode = comparison.equal ? 0 : 1;
        break;
      }
    }
    const text = JSON.stringify(result, null, 2);
    process.stdout.write(`${text}\n`);
  }
} catch (error) {
  const failure =
    error instanceof AbilityBenchError
      ? error
      : new AbilityBenchError("record_unreadable", "Unable to read history.", "cli");
  process.stderr.write(
    json
      ? `${JSON.stringify({ error: { code: failure.code, message: failure.message, operation: failure.operation, ...failure.context } })}\n`
      : `${failure.code}: ${failure.message}\n`,
  );
  process.exitCode = 2;
}
