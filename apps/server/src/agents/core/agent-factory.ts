import type { AgentDefinition } from "./agent-definition";
import type { AgentRole } from "./agent-role";
import type { AgentPrompt, AgentRuntime } from "./agent-runtime";
import type { AgentTool } from "./agent-tool";

export type AgentImageAnalyzer = (prompt: AgentPrompt) => Promise<string>;

export interface AgentToolContext {
  /** Analyzes images via the configured image model, when available. */
  readonly analyzeImage?: AgentImageAnalyzer;
  /** Returns the requester id for the currently executing turn, if any. */
  readonly requesterId: () => string | undefined;
}

export type AgentToolsFactory<TTool extends AgentTool = AgentTool> = (
  context: AgentToolContext,
) => readonly TTool[];

export interface AgentCreationOptions {
  readonly role: AgentRole;
  readonly sessionKey: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly initialContext?: string;
  /** Continue the most recent session in the session directory instead of starting a new one. */
  readonly resumeSession?: boolean;
}

/**
 * Creates an agent runtime. The factory passes runtime capabilities and
 * turn-scoped state via {@link AgentToolContext} when building tools.
 */
export interface AgentFactory<TTool extends AgentTool = AgentTool> {
  create(
    definition: AgentDefinition,
    createTools: AgentToolsFactory<TTool>,
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
