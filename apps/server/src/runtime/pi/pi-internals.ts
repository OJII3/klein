/**
 * Pi does not export its MCP config loader, the `pi mcp` command, or the QuickJS WASM path
 * setter from the package root, so those internal imports live here: an upstream file layout
 * change breaks this module, not the runtime. Re-check on every `@earendil-works/pi-coding-agent`
 * upgrade.
 *
 * At dev/test runtime this module resolves `@earendil-works/pi-coding-agent/package.json` without
 * hardcoding `node_modules` paths. During production bundling, `apps/server/scripts/build.ts`
 * replaces this module with static re-exports so `Bun.build` bundles the internals directly.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { createMcpExtension } from "@earendil-works/pi-coding-agent";

type McpExtensionOptions = NonNullable<Parameters<typeof createMcpExtension>[0]>;
export type LoadedPiMcpConfig = ReturnType<NonNullable<McpExtensionOptions["loadConfig"]>>;

export interface PiMcpCommandOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly openUrl?: (url: string) => void;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

type LoadMcpConfigFn = (options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
}) => LoadedPiMcpConfig;

type RunMcpCommandFn = (args: string[], options: PiMcpCommandOptions) => Promise<number>;
type SetEmbeddedQuickJSWasmPathFn = (path: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoadMcpConfigFn(value: unknown): value is LoadMcpConfigFn {
  return typeof value === "function";
}

function isRunMcpCommandFn(value: unknown): value is RunMcpCommandFn {
  return typeof value === "function";
}

function isSetEmbeddedQuickJSWasmPathFn(value: unknown): value is SetEmbeddedQuickJSWasmPathFn {
  return typeof value === "function";
}

const require = createRequire(import.meta.url);
const piPackageDir = dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));

async function loadInternalModule(relativePath: string): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(pathToFileURL(resolve(piPackageDir, relativePath)).href);
  if (!isRecord(loaded)) {
    throw new TypeError(`Invalid module export shape for ${relativePath}`);
  }
  return loaded;
}

const mcpConfigModule = await loadInternalModule("dist/extensions/mcp/config.js");
const rawLoadMcpConfig = mcpConfigModule.loadMcpConfig;
if (!isLoadMcpConfigFn(rawLoadMcpConfig)) {
  throw new TypeError("Missing exported function loadMcpConfig in dist/extensions/mcp/config.js");
}
export const loadMcpConfig: LoadMcpConfigFn = rawLoadMcpConfig;

const mcpCliModule = await loadInternalModule("dist/extensions/mcp/cli.js");
const rawRunMcpCommand = mcpCliModule.runMcpCommand;
if (!isRunMcpCommandFn(rawRunMcpCommand)) {
  throw new TypeError("Missing exported function runMcpCommand in dist/extensions/mcp/cli.js");
}
export const runPiMcpCommand: RunMcpCommandFn = rawRunMcpCommand;

const piConfigModule = await loadInternalModule("dist/config.js");
const rawSetEmbeddedQuickJSWasmPath = piConfigModule.setEmbeddedQuickJSWasmPath;
if (!isSetEmbeddedQuickJSWasmPathFn(rawSetEmbeddedQuickJSWasmPath)) {
  throw new TypeError("Missing exported function setEmbeddedQuickJSWasmPath in dist/config.js");
}
export const setEmbeddedQuickJSWasmPath: SetEmbeddedQuickJSWasmPathFn =
  rawSetEmbeddedQuickJSWasmPath;
