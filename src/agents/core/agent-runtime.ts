export interface AgentRuntime {
  prompt(content: string): Promise<void>;
  dispose(): void;
}
