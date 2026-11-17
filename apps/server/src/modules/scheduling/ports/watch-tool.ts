import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";

export interface WatchToolExecutionContext {
  readonly signal: AbortSignal;
}

/**
 * A tool a watch script can call as `tools.<name>(args)`.
 *
 * Watch tools are deliberately separate from the session's tools: the runner
 * only exposes this catalog, and the agent sees its declarations in the
 * `watch` prompt section.
 */
export interface WatchTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: CodemodeJsonSchema;
  readonly outputSchema?: CodemodeJsonSchema;
  execute(args: unknown, context: WatchToolExecutionContext): Promise<unknown>;
}

export interface WatchToolCatalog {
  readonly tools: readonly WatchTool[];
}
