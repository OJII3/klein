import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentTool } from "@agents/core/agent-tool";

/** A Pi tool that also carries the core tool metadata. */
export type PiTool = ToolDefinition & AgentTool;
