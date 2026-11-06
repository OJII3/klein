import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_SKILL_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 2_000;

/**
 * Pi advertises skills only when a `read` or `bash` tool is declared, and the model loads
 * SKILL.md through that tool. Klein excludes the built-in filesystem tools, so this tool
 * replaces `read` with a reader restricted to the configured skills directory.
 */
export function createSkillReadTool(skillsDirectory: string) {
  const root = resolve(skillsDirectory);

  return defineTool({
    name: "read",
    label: "Read Skill File",
    description:
      "Read a text file from the configured skills directory. Use this to load a skill's SKILL.md and its references. Paths outside the skills directory are rejected.",
    promptSnippet: "Read a skill's SKILL.md and references from the configured skills directory.",
    promptGuidelines: ["Use read only for files under the configured skills directory."],
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const target = await resolveSkillPath(root, params.path);
      const fileStat = await stat(target);
      if (!fileStat.isFile()) throw new Error(`Not a skill file: ${params.path}`);
      if (fileStat.size > MAX_SKILL_READ_BYTES) {
        throw new Error(`Skill file is too large to read: ${params.path}`);
      }

      const buffer = await readFile(target);
      if (buffer.includes(0)) throw new Error(`Skill file is not text: ${params.path}`);
      const lines = buffer.toString("utf8").split("\n");
      const start = (params.offset ?? 1) - 1;
      if (start >= lines.length) {
        throw new Error(`Offset ${params.offset} is beyond the end of ${params.path}`);
      }
      const end = Math.min(start + (params.limit ?? DEFAULT_MAX_LINES), lines.length);
      const truncated = params.limit === undefined && end < lines.length;

      return {
        content: [
          {
            type: "text",
            text: `${lines.slice(start, end).join("\n")}${truncated ? "\n… (truncated)" : ""}`,
          },
        ],
        details: { path: target, totalLines: lines.length, truncated },
      };
    },
  });
}

async function resolveSkillPath(root: string, input: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new Error(`Skills directory is not available: ${root}`);
  }

  // The model normally receives absolute skill paths, but accept paths relative to the
  // skills root or the working directory as well.
  const candidates = isAbsolute(input)
    ? [resolve(input)]
    : [resolve(realRoot, input), resolve(process.cwd(), input)];

  for (const candidate of candidates) {
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      continue;
    }

    const relativePath = relative(realRoot, target);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
      return target;
    }
  }

  throw new Error(`Skill file is not readable: ${input}`);
}
