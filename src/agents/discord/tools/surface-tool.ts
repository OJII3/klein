import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * Defines a tool that writes to the conversation surface. The core layer uses
 * the marker to keep surface tools away from roles that may not speak. A
 * primary surface tool is the default way the agent reaches the conversation;
 * other surface tools serve narrower purposes.
 */
export function defineSurfaceTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
  options?: { readonly primary?: boolean },
) {
  return {
    ...defineTool(tool),
    surface: true as const,
    ...(options?.primary ? { primarySurface: true as const } : {}),
  };
}
