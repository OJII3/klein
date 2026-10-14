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

export interface AgentExecutionOptions {
  /** Set only by trusted application access checks, never by event content. */
  readonly ownerFeaturesAllowed?: boolean;
}

export interface AgentRuntime {
  prompt(event: AgentEvent, options?: AgentExecutionOptions): Promise<void>;
  steer?(event: AgentEvent, options?: AgentExecutionOptions): Promise<void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
