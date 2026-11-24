import type { AgentTurn } from "./agent-turn";

export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly traceId?: string;
  readonly text: string;
  readonly images: readonly AgentImage[];
  readonly focus?: string;
  readonly eventId?: string;
}

export type AgentTurnProgress = "none" | "started" | "uncertain" | "completed";

export interface AgentRuntime {
  prompt(turn: AgentTurn): Promise<string | undefined>;
  steer?(turn: AgentTurn): Promise<void>;
  abort?(): Promise<void>;
  compactForHandoff?(): Promise<string>;
  getTurnProgress?(eventId: string): AgentTurnProgress;
  dispose(): void;
}
