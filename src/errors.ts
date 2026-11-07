export type ErrorContext = {
  runId?: string;
  attemptId?: string;
  stageId?: string;
  side?: "left" | "right";
  file?: string;
  path?: string;
  limit?: number;
  actualBytes?: number;
  causeCode?: string;
  status?: string;
  reason?: string;
};

export type AbilityBenchErrorCode =
  | "invalid_argument"
  | "invalid_declaration"
  | "invalid_json_value"
  | "history_not_found"
  | "run_not_found"
  | "stage_not_found"
  | "output_absent"
  | "artifact_not_found"
  | "corrupt_artifact"
  | "artifact_unreadable"
  | "corrupt_record"
  | "record_unreadable"
  | "unsupported_history_format"
  | "read_limit_exceeded"
  | "unsafe_path";

export class AbilityBenchError extends Error {
  declare readonly runId?: string;
  declare readonly attemptId?: string;
  declare readonly stageId?: string;
  declare readonly side?: "left" | "right";
  declare readonly file?: string;
  declare readonly path?: string;
  declare readonly limit?: number;
  declare readonly actualBytes?: number;
  declare readonly causeCode?: string;
  declare readonly status?: string;
  declare readonly reason?: string;
  constructor(
    readonly code: AbilityBenchErrorCode,
    message: string,
    readonly operation: string,
    readonly context: ErrorContext = {},
  ) {
    super(message);
    this.name = "AbilityBenchError";
    Object.assign(this, context);
  }
}
