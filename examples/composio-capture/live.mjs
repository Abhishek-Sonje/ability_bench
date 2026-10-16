// Isolated fail-closed entry. Deliberately imports no SDK, .env loader or native transport.
import { experimentPreflight } from "./experiment-profile.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--preflight") {
  process.stdout.write(`${JSON.stringify(experimentPreflight(), null, 2)}\n`);
} else {
  const authorized = args.length === 1 && args[0] === "--authorize-live-salesforce-bounded-v1";
  process.stderr.write(
    authorized
      ? "Live execution refused: unresolved token, tool-cost, backend safety and account reconciliation gates. No requests sent.\n"
      : "Explicit live authorization required. Use --preflight for the offline readiness report. No requests sent.\n",
  );
  process.exitCode = 1;
}
