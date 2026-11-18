/**
 * A tool the agent runtime may call. The core layer depends only on the name
 * and whether the tool writes to the conversation surface; the runtime adapter
 * owns the rest of the tool's shape.
 */
export interface AgentTool {
  readonly name: string;
  /** Whether calling this tool writes to the conversation surface. */
  readonly surface?: boolean;
  readonly primarySurface?: boolean;
  /** The outcome recorded when this surface tool completes a turn. */
  readonly surfaceOutcome?: string;
}
