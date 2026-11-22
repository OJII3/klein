export type AgentEventContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface AgentEvent {
  /** Used for internal tracing, never included in the model's event metadata. */
  readonly id: string;
  /** ISO 8601 occurrence time including a timezone, retaining the original precision. */
  readonly occurredAt: string;
  readonly type: string;
  readonly source: string;
  readonly content: readonly AgentEventContent[];
}
