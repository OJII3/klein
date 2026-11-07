/**
 * Pi does not export its MCP config loader or the `pi mcp` command from the package root, so the
 * deep imports live here: an upstream file layout change breaks this module, not the runtime.
 * Re-check on every `@earendil-works/pi-coding-agent` upgrade.
 */
export { loadMcpConfig } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
export { runMcpCommand as runPiMcpCommand } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/cli.js";
