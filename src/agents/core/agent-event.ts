import type { AgentPrompt } from "./agent-runtime";

/** An input from any producer, independent of the agent's runtime. */
export interface AgentEvent extends Omit<AgentPrompt, "traceId"> {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  /** Source-specific, JSON-serializable metadata. Image bytes belong in images. */
  readonly data?: Readonly<Record<string, unknown>>;
}
