export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly traceId?: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly text: string;
  readonly images: readonly AgentImage[];
}

export interface AgentRuntime {
  prompt(prompt: AgentPrompt): Promise<void>;
  steer?(prompt: AgentPrompt): Promise<void>;
  abort?(): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
