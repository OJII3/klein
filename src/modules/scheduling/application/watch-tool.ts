import { renderDeclarations, type CodemodeJsonSchema } from "@earendil-works/pi-codemode";

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

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

/**
 * Render the declarations of the tools watch scripts can call.
 *
 * Mirrors the `codemode` prompt section: the agent sees the same TypeScript
 * declarations that the sandbox uses, once `watch_add` is offered.
 */
export function renderWatchToolSection(catalog: WatchToolCatalog): string | undefined {
  if (catalog.tools.length === 0) return undefined;
  const declarations = catalog.tools.map((tool) => ({
    ...tool,
    outputSchema: tool.outputSchema ?? TEXT_OUTPUT_SCHEMA,
  }));
  return [
    "Inside a watch script, call these tools with `await tools.<name>({ ...args })`. Only these tools are available; normal session tools, timers, files, and process APIs are not.",
    "`store(key, value)` and `load(key)` keep JSON values between checks of the same watch; the state is deleted with the watch.",
    ["```ts", renderDeclarations({ tools: declarations }).trim(), "```"].join("\n"),
  ].join("\n\n");
}
