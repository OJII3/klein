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

export interface AgentOutputSink {
  writeAssistantText(text: string): Promise<void> | void;
}

export interface AgentRuntime {
  prompt(event: AgentEvent): Promise<void>;
  steer?(event: AgentEvent): Promise<void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
