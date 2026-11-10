import type { AgentTurn } from "./agent-turn";

export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly traceId?: string;
  readonly text: string;
  readonly images: readonly AgentImage[];
}

export interface AgentRuntime {
  prompt(turn: AgentTurn): Promise<void>;
  steer?(turn: AgentTurn): Promise<void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
