export interface ToolUsageStat {
  readonly name: string;
  readonly calls: number;
  readonly errors: number;
  readonly lastCalledAt: string | null;
}

export interface McpServerUsageStat {
  readonly name: string;
  readonly calls: number;
  readonly errors: number;
  readonly toolCount: number;
  readonly lastCalledAt: string | null;
}

export interface ToolUsageReport {
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly sessionCount: number;
  readonly tools: readonly ToolUsageStat[];
  readonly mcpServers: readonly McpServerUsageStat[];
}
