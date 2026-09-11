export interface AgentImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPrompt {
  readonly text: string;
  readonly images: readonly AgentImage[];
}

export interface AgentRuntime {
  prompt(prompt: AgentPrompt): Promise<void>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  dispose(): void;
}
