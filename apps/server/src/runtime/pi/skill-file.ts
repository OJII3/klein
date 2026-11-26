import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SKILL_READ_BYTES = 256 * 1024;

export type SkillFileErrorReason =
  "unavailable" | "unsafe" | "missing" | "not-file" | "too-large" | "binary";

export class SkillFileError extends Error {
  constructor(
    readonly reason: SkillFileErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillFileError";
  }
}

export interface SkillFileRead {
  readonly path: string;
  readonly content: string;
  readonly totalLines: number;
}

export async function readSkillFile(
  roots: string | readonly string[],
  input: string,
): Promise<SkillFileRead> {
  const target = await resolveSkillPath(roots, input);

  let fileStat;
  try {
    fileStat = await stat(target);
  } catch (error) {
    throw new SkillFileError("missing", `Skill file is not readable: ${input}`, { cause: error });
  }
  if (!fileStat.isFile()) {
    throw new SkillFileError("not-file", `Not a skill file: ${input}`);
  }
  if (fileStat.size > MAX_SKILL_READ_BYTES) {
    throw new SkillFileError("too-large", `Skill file is too large to read: ${input}`);
  }

  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    throw new SkillFileError("binary", `Skill file is not text: ${input}`);
  }
  const content = buffer.toString("utf8");

  return { path: target, content, totalLines: content.split("\n").length };
}

export async function resolveSkillPath(
  roots: string | readonly string[],
  input: string,
): Promise<string> {
  const rootList = typeof roots === "string" ? [roots] : roots;
  const realRoots: string[] = [];
  for (const root of rootList) {
    try {
      realRoots.push(await realpath(resolve(root)));
    } catch {
      continue;
    }
  }
  if (realRoots.length === 0) {
    throw new SkillFileError(
      "unavailable",
      `Skills directory is not available: ${rootList.join(", ")}`,
    );
  }

  if (isAbsolute(input)) {
    let target: string;
    try {
      target = await realpath(resolve(input));
    } catch {
      throw new SkillFileError("missing", `Skill file is not readable: ${input}`);
    }
    if (realRoots.some((realRoot) => isWithinRoot(realRoot, target))) return target;
    throw new SkillFileError("unsafe", `Skill file is not readable: ${input}`);
  }

  let escapedRoot = false;
  for (const realRoot of realRoots) {
    let target: string;
    try {
      target = await realpath(resolve(realRoot, input));
    } catch {
      continue;
    }
    if (isWithinRoot(realRoot, target)) return target;
    escapedRoot = true;
  }

  const cwdTarget = await realpath(resolve(process.cwd(), input)).catch(() => undefined);
  if (cwdTarget) {
    if (realRoots.some((realRoot) => isWithinRoot(realRoot, cwdTarget))) return cwdTarget;
    escapedRoot = true;
  }

  throw new SkillFileError(
    escapedRoot ? "unsafe" : "missing",
    `Skill file is not readable: ${input}`,
  );
}

function isWithinRoot(realRoot: string, target: string): boolean {
  const relativePath = relative(realRoot, target);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}
