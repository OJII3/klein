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

export async function readSkillFile(root: string, input: string): Promise<SkillFileRead> {
  const target = await resolveSkillPath(resolve(root), input);

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

async function resolveSkillPath(root: string, input: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    throw new SkillFileError("unavailable", `Skills directory is not available: ${root}`, {
      cause: error,
    });
  }

  const candidates = isAbsolute(input)
    ? [resolve(input)]
    : [resolve(realRoot, input), resolve(process.cwd(), input)];

  let escapedRoot = false;
  for (const candidate of candidates) {
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      continue;
    }

    const relativePath = relative(realRoot, target);
    const escapesRoot =
      relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
    if (!escapesRoot) return target;
    escapedRoot = true;
  }

  throw new SkillFileError(
    escapedRoot ? "unsafe" : "missing",
    `Skill file is not readable: ${input}`,
  );
}
