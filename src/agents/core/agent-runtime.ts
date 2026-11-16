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
  /** The event that produced this prompt, when the prompt came from an event. */
  readonly eventId?: string;
}

export interface AgentRuntime {
  prompt(turn: AgentTurn): Promise<void>;
  steer?(turn: AgentTurn): Promise<void>;
  abort?(): Promise<void>;
  compactForHandoff?(): Promise<string>;
  /** The assistant text from the most recent completed turn, if any. */
  lastAssistantText?(): string | undefined;
  dispose(): void;
}
