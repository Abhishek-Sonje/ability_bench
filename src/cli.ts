#!/usr/bin/env node

import { runCli } from "./cli-command.js";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  environment: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
