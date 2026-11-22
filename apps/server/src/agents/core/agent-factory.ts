import type { AccessScope } from "@shared/access";
import type { AgentDefinition } from "./agent-definition";
import type { AgentRole } from "./agent-role";
import type { AgentPrompt, AgentRuntime } from "./agent-runtime";
import type { AgentTool } from "./agent-tool";

export type AgentImageAnalyzer = (prompt: AgentPrompt) => Promise<string>;

export interface AgentToolContext {
  readonly analyzeImage?: AgentImageAnalyzer;
  readonly requesterId: () => string | undefined;
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
}

export interface AgentFactory<TTool extends AgentTool = AgentTool> {
  create(
    definition: AgentDefinition,
    createTools: AgentToolsFactory<TTool>,
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
