import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readSkillFile } from "./skill-file";

const DEFAULT_MAX_LINES = 2_000;

/**
 * Pi advertises skills only when a `read` or `bash` tool is declared, and the model loads
 * SKILL.md through that tool. Klein excludes the built-in filesystem tools, so this tool
 * replaces `read` with a reader restricted to the configured skills directory.
 */
export function createSkillReadTool(skillsDirectory: string) {
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
      const file = await readSkillFile(skillsDirectory, params.path);
      const lines = file.content.split("\n");
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
        details: { path: file.path, totalLines: file.totalLines, truncated },
      };
    },
  });
}
