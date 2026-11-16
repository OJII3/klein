import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * Defines a tool that writes to the conversation surface. The core layer uses
 * the marker to keep surface tools away from roles that may not speak.
 */
export function defineSurfaceTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
) {
  return { ...defineTool(tool), surface: true as const };
}
