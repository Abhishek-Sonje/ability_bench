import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { BuiltWorkflow } from "./types.js";
import { ABILITYBENCH_CONTRACT_VERSION } from "./version.js";

export interface LoadedWorkflowConfig {
  readonly configPath: string;
  readonly workflowPath: string;
  readonly storageDir: string;
  readonly workflow: BuiltWorkflow;
}

export type ConfigErrorCode =
  | "config_not_found"
  | "invalid_config"
  | "invalid_workflow_export"
  | "path_escaped"
  | "workflow_not_found";

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadWorkflowConfig(
  configPath = resolve(process.cwd(), "abilitybench.config.ts"),
): Promise<LoadedWorkflowConfig> {
  const absoluteConfigPath = resolve(configPath);
  if (!(await existsFile(absoluteConfigPath))) {
    throw new ConfigError("config_not_found", `Config file "${absoluteConfigPath}" was not found.`);
  }
  const configDirectory = dirname(absoluteConfigPath);
  const imported: unknown = await import(pathToFileURL(absoluteConfigPath).href);
  const config = readDefaultExport(imported);
  const { workflow: workflowSetting, storageDir: storageSetting } = config ?? {};
  if (
    config === null ||
    typeof workflowSetting !== "string" ||
    workflowSetting.length === 0 ||
    (storageSetting !== undefined && typeof storageSetting !== "string")
  ) {
    throw new ConfigError(
      "invalid_config",
      `Config "${absoluteConfigPath}" must default-export a workflow path and optional storageDir.`,
    );
  }

  const workflowPath = containedPath(configDirectory, workflowSetting);
  const storageDir = containedPath(configDirectory, storageSetting ?? ".abilitybench");
  if (!(await existsFile(workflowPath))) {
    throw new ConfigError("workflow_not_found", `Workflow module "${workflowPath}" was not found.`);
  }
  const module: unknown = await import(pathToFileURL(workflowPath).href);
  const workflow = readDefaultExport(module);
  if (!isBuiltWorkflow(workflow)) {
    throw new ConfigError(
      "invalid_workflow_export",
      `Workflow module "${workflowPath}" must default-export a built workflow.`,
    );
  }
  if (resolve(workflow.root) !== configDirectory) {
    throw new ConfigError(
      "invalid_workflow_export",
      `Workflow root "${workflow.root}" must match the config directory "${configDirectory}".`,
    );
  }
  return Object.freeze({ configPath: absoluteConfigPath, workflowPath, storageDir, workflow });
}

function readDefaultExport(module: unknown): Record<string, unknown> | null {
  if (module === null || typeof module !== "object" || !("default" in module)) return null;
  const value: unknown = module.default;
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isBuiltWorkflow(value: unknown): value is BuiltWorkflow {
  if (value === null || typeof value !== "object") return false;
  const { contractVersion, id, root, stages, topologicalOrder } = value as {
    contractVersion?: unknown;
    id?: unknown;
    root?: unknown;
    stages?: unknown;
    topologicalOrder?: unknown;
  };
  return (
    contractVersion === ABILITYBENCH_CONTRACT_VERSION &&
    typeof id === "string" &&
    typeof root === "string" &&
    Array.isArray(stages) &&
    Array.isArray(topologicalOrder) &&
    Object.isFrozen(value)
  );
}

function containedPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const remainder = relative(root, absolute);
  if (
    path.length === 0 ||
    remainder === ".." ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  ) {
    throw new ConfigError("path_escaped", `Path "${path}" escapes config directory "${root}".`);
  }
  return absolute;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
