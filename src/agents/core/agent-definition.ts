export type AgentOutputMode = "discord_tool" | "assistant_text";

export interface AgentDefinition {
  readonly systemPrompt: string;
  readonly outputMode?: AgentOutputMode;
}
