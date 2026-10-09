export interface AgentDefinition {
  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
  readonly enableMcp?: boolean;
}
