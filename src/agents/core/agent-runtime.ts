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
  promptWithResponse?(prompt: AgentPrompt): Promise<string | undefined>;
  analyzeImage?(prompt: AgentPrompt): Promise<string>;
  compactForHandoff?(): Promise<string>;
  dispose(): void;
}
