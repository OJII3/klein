import type { AgentTurn } from "./agent-turn";

export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly traceId?: string;
  readonly text: string;
  readonly images: readonly AgentImage[];
  /** What the caller needs from the image. Keeps a short analysis relevant. */
  readonly focus?: string;
  /** Discord message ID when the prompt came from a Discord message. */
  readonly messageId?: string;
}

export interface AgentRuntime {
  prompt(turn: AgentTurn): Promise<void>;
  steer?(turn: AgentTurn): Promise<void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
