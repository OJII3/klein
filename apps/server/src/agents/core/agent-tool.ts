export interface AgentTool {
  readonly name: string;
  readonly surface?: boolean;
  readonly primarySurface?: boolean;
  readonly surfaceOutcome?: string;
}
