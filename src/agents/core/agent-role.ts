/**
 * How an agent relates to a conversation.
 *
 * The role decides whether the agent may write to the conversation surface, how
 * long its session lives, and where a completed turn's assistant text goes.
 *
 * - conversation: belongs to one conversation and owns its surface.
 * - attached: belongs to one conversation but returns results to the conversation agent.
 * - standalone: belongs to no conversation; the caller owns its result.
 */
export type ConversationAgentRole = { readonly kind: "conversation" };
export type AttachedAgentRole = { readonly kind: "attached"; readonly taskId: string };
export type StandaloneAgentRole = { readonly kind: "standalone" };

export type NonConversationAgentRole = AttachedAgentRole | StandaloneAgentRole;

export type AgentRole = ConversationAgentRole | NonConversationAgentRole;

export interface AgentPolicy {
  /** Who may write to the conversation surface. */
  readonly surface: "owner" | "none";
  /** How long the agent's session lives. */
  readonly lifetime: "conversation" | "task" | "call";
  /** Where a completed turn's assistant text goes. */
  readonly assistantText: "none" | "caller";
}

export function resolveAgentPolicy(role: AgentRole): AgentPolicy {
  switch (role.kind) {
    case "conversation":
      return { surface: "owner", lifetime: "conversation", assistantText: "none" };
    case "attached":
      return { surface: "none", lifetime: "task", assistantText: "caller" };
    case "standalone":
      return { surface: "none", lifetime: "call", assistantText: "caller" };
  }
}

/**
 * Tools that write to the Discord surface. Only a conversation agent may hold
 * them; an attached or standalone agent returns its result to its caller
 * instead of speaking.
 */
const SURFACE_TOOL_NAMES: readonly string[] = ["discord_send", "discord_speak", "discord_voice"];

export function findSurfaceTool(role: AgentRole, toolNames: readonly string[]): string | undefined {
  if (resolveAgentPolicy(role).surface === "owner") return undefined;
  return toolNames.find((name) => SURFACE_TOOL_NAMES.includes(name));
}

export function assertSurfaceToolsAllowed(role: AgentRole, toolNames: readonly string[]): void {
  const surfaceTool = findSurfaceTool(role, toolNames);
  if (surfaceTool !== undefined) {
    throw new Error(`The ${role.kind} agent role may not use the surface tool ${surfaceTool}`);
  }
}
