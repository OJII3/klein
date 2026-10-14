import type { AgentEvent } from "./agent-event";

export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly traceId?: string;
  /** Set only by trusted application access checks, never by event payloads. */
  readonly ownerFeaturesAllowed?: boolean;
  readonly text: string;
  readonly images: readonly AgentImage[];
}

export interface AgentRuntime {
  prompt(event: AgentEvent): Promise<void>;
  steer?(event: AgentEvent): Promise<void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
