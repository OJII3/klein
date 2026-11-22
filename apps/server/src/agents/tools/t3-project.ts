import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_PROJECTS = 100;
const MAX_TOOL_OUTPUT_CHARS = 20_000;

export interface T3Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface T3ProjectLister {
  list(signal?: AbortSignal): Promise<readonly T3Project[]>;
}

export function createT3ProjectListTool(lister: T3ProjectLister): ToolDefinition {
  return defineTool({
    name: "t3_project_list",
    label: "List T3 Projects",
    description:
      "List T3 Code projects with their ids, titles, and workspace paths. " +
      "Use a project id or a path inside the workspace as the project for a T3 Code thread.",
    promptSnippet: "List T3 Code projects and their workspace paths.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const projects = await lister.list(signal);
      return {
        content: [{ type: "text", text: formatProjects(projects) }],
        details: { projects },
      };
    },
  });
}

function formatProjects(projects: readonly T3Project[]): string {
  if (projects.length === 0) return "No T3 Code projects.";
  const lines = projects
    .slice(0, MAX_PROJECTS)
    .map((project) => `- ${project.title}  ${project.workspaceRoot}  (${project.id})`);
  if (projects.length > MAX_PROJECTS) {
    lines.push(`… (${projects.length - MAX_PROJECTS} more)`);
  }
  return limitOutput(lines.join("\n"));
}

function limitOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`;
}
