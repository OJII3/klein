import {
  renderDeclarations,
  type CodemodeJsonSchema,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";

import type { WatchTool, WatchToolCatalog } from "../ports/watch-tool";

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export interface WatchToolSectionOptions {
  readonly ownerFeaturesAllowed?: boolean;
}

export function filterWatchToolsForAudience(
  tools: readonly WatchTool[],
  ownerFeaturesAllowed: boolean,
): readonly WatchTool[] {
  return tools.filter((tool) => tool.audience !== "owner" || ownerFeaturesAllowed);
}

/**
 * Mirrors the `codemode` prompt section: the agent sees the same TypeScript
 * declarations that the sandbox uses, once `watch_add` is offered.
 */
export function renderWatchToolSection(
  catalog: WatchToolCatalog,
  options: WatchToolSectionOptions = {},
): string | undefined {
  const tools = filterWatchToolsForAudience(catalog.tools, options.ownerFeaturesAllowed === true);
  if (tools.length === 0) return undefined;
  const declarations: CodemodeTool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? TEXT_OUTPUT_SCHEMA,
    execute: (args, { signal }) => tool.execute(args, { signal }),
  }));
  return [
    "Inside a watch script, call these tools with `await tools.<name>({ ...args })`. Only these tools are available; normal session tools, timers, files, and process APIs are not.",
    "End every check with `wake()` to notify the agent or `silent()` to do nothing; ending without either is an error.",
    "`store(key, value)` and `load(key)` keep JSON values between checks of the same watch; the state is deleted with the watch.",
    ["```ts", renderDeclarations({ tools: declarations }).trim(), "```"].join("\n"),
  ].join("\n\n");
}
