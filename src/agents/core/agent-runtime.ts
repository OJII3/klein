import type { AgentEvent } from "./agent-event";

export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly traceId?: string;
  readonly text: string;
  readonly images: readonly AgentImage[];
}

export interface AgentPromptResult {
  readonly assistantText?: string;
}

export interface AgentRuntime {
  prompt(event: AgentEvent): Promise<AgentPromptResult | void>;
  steer?(event: AgentEvent): Promise<AgentPromptResult | void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
