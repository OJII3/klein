import type { AccessScope } from "@shared/access";
import type { AgentDefinition } from "./agent-definition";
import type { AgentRole } from "./agent-role";
import type { AgentPrompt, AgentRuntime } from "./agent-runtime";
import type { AgentTool } from "./agent-tool";

export type AgentImageAnalyzer = (prompt: AgentPrompt) => Promise<string>;

export interface AgentToolContext {
  readonly analyzeImage?: AgentImageAnalyzer;
  readonly requesterId: () => string | undefined;
  /** Location of this agent's persisted session, once it has one. */
  readonly sessionFilePath?: () => string | undefined;
}

export type AgentToolsFactory<TTool extends AgentTool = AgentTool> = (
  context: AgentToolContext,
) => readonly TTool[];

export interface AgentCreationOptions {
  readonly role: AgentRole;
  readonly sessionKey: string;
  readonly ownerFeaturesAllowed?: boolean;
  /** Private scope of the conversation, which also names the browser profile. */
  readonly accessScope?: AccessScope;
  readonly initialContext?: string;
  readonly resumeSession?: boolean;
  /**
   * Start from a copy of another session's active history, cut at its latest
   * user message. Used so a worker inherits the conversation that spawned it.
   */
  readonly inheritContextFromSessionFile?: string;
}

export interface AgentFactory<TTool extends AgentTool = AgentTool> {
  create(
    definition: AgentDefinition,
    createTools: AgentToolsFactory<TTool>,
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
