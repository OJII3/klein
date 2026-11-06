import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type PiTool = ToolDefinition;

export function adaptPiTools<TTool>(tools: readonly TTool[]): PiTool[] {
  return tools as unknown as PiTool[];
}
