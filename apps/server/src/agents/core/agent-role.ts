import type { AgentTool } from "./agent-tool";

export type ConversationAgentRole = { readonly kind: "conversation" };
export type WorkerAgentRole = { readonly kind: "worker"; readonly workerId: string };
export type StandaloneAgentRole = { readonly kind: "standalone" };

export type AgentRole = ConversationAgentRole | WorkerAgentRole | StandaloneAgentRole;

export interface AgentPolicy {
  readonly surface: "owner" | "none";
  readonly lifetime: "conversation" | "task" | "call";
  readonly assistantText: "none" | "caller";
}

export function resolveAgentPolicy(role: AgentRole): AgentPolicy {
  switch (role.kind) {
    case "conversation":
      return { surface: "owner", lifetime: "conversation", assistantText: "none" };
    case "worker":
      return { surface: "none", lifetime: "task", assistantText: "caller" };
    case "standalone":
      return { surface: "none", lifetime: "call", assistantText: "caller" };
    default: {
      const exhaustive: never = role;
      throw new Error(`Unsupported agent role: ${String(exhaustive)}`);
    }
  }
}
export function findSurfaceTool(role: AgentRole, tools: readonly AgentTool[]): string | undefined {
  if (resolveAgentPolicy(role).surface === "owner") return undefined;
  return tools.find((tool) => tool.surface === true)?.name;
}

export function assertSurfaceToolsAllowed(role: AgentRole, tools: readonly AgentTool[]): void {
  const surfaceTool = findSurfaceTool(role, tools);
  if (surfaceTool !== undefined) {
    throw new Error(`The ${role.kind} agent role may not use the surface tool ${surfaceTool}`);
  }
}
