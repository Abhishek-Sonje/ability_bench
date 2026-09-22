import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(path: string, root: string) {
    super(`Path "${path}" resolves outside "${root}".`);
    this.name = "PathEscapeError";
  }
}

/** Resolves a path inside root, including every existing symlinked ancestor. */
export async function resolveContainedPath(root: string, path: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  if (path.length === 0 || !isInside(absoluteRoot, absolutePath)) {
    throw new PathEscapeError(path, absoluteRoot);
  }
  const physicalRoot = await realpath(absoluteRoot);
  let existing = absolutePath;
  while (true) {
    try {
      const physical = await realpath(existing);
      if (!isInside(physicalRoot, physical)) throw new PathEscapeError(path, absoluteRoot);
      return absolutePath;
    } catch (error: unknown) {
      if (error instanceof PathEscapeError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new PathEscapeError(path, absoluteRoot);
      existing = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}
