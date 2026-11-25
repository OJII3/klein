import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { CodingProject } from "@modules/coding/domain/coding-session";

const MAX_PROJECTS = 100;
const MAX_TOOL_OUTPUT_CHARS = 20_000;

export function createCodingProjectListTool(registry: CodingBackendRegistry): ToolDefinition {
  return defineTool({
    name: "coding_project_list",
    label: "List Coding Projects",
    description:
      "List projects known to a coding backend, with their ids, titles, and workspace paths. " +
      "Use a project id or a path inside the workspace as the project for a coding session.",
    promptSnippet: "List coding projects and their workspace paths.",
    parameters: Type.Object({
      backend: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 100,
          description: `Coding backend id. Defaults to "${registry.defaultId}".`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const backend = registry.get(params.backend);
      if (!backend.listProjects || !backend.capabilities.projects) {
        return {
          content: [
            {
              type: "text",
              text: `Coding backend "${backend.id}" does not list projects. Pass a repository path as project.`,
            },
          ],
          details: { backend: backend.id, projects: [] },
        };
      }
      const projects = await backend.listProjects(signal);
      return {
        content: [{ type: "text", text: formatProjects(backend.label, projects) }],
        details: { backend: backend.id, projects },
      };
    },
  });
}

function formatProjects(label: string, projects: readonly CodingProject[]): string {
  if (projects.length === 0) return `No ${label} projects.`;
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
