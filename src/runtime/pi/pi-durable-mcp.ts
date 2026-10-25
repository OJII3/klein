/**
 * MCP integration for the pi-durable runtime: configuration, OAuth credentials, server connections,
 * and the tools that expose them.
 *
 * Adapted from `@earendil-works/pi-coding-agent` 1.4.0 (MIT, Earendil Works):
 * `dist/extensions/mcp/{config,oauth,runtime,tools}.js`, `dist/core/mcp-servers.js`, and
 * `dist/core/resolve-config-value.js`. Keep this file in step with those sources when upgrading;
 * the intentional difference is the credential store's own file locking.
 */
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  JSON_RPC_ERROR_CODES,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type AuthProvider,
  type CallToolResult,
  type ContentBlock,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type McpFetch,
  type McpRequestOptions,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  parseWwwAuthenticate,
  stepUpScope,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthCallbackPage,
  type OAuthChallenge,
  type OAuthClientInformationMixed,
} from "@earendil-works/pi-mcp/oauth";
import { Type } from "typebox";

import { ToolAuthorization, type ToolPermissions } from "./tool-permissions";

const CONFIG_DIR_NAME = ".pi";
const CLIENT_NAME = "pi";
// Reported to MCP servers in `initialize`. Keep in step with package.json.
const CLIENT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];
const MAX_TOOL_NAME_LENGTH = 64;
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
const OUTPUT_FILE_MODE = 0o600;
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8" as const, mode: 0o600 };

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const CLIENT_METADATA_BASE_URL = "https://pi.dev/oauth";
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
const REFRESH_SKEW_MS = 30_000;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_LOCK_STALE_MS = 20_000;
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_WAIT_MS = 30_000;
const AUTH_LOCK_RETRY_MS = 20;

export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

const MCP_EXPOSURE_ALIASES: Record<string, McpExposure> = {
  "codemode-deferred": "codemode",
};
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

interface McpServerConfigBase {
  exposure?: McpExposure;
  description?: string;
  toolExposure?: Record<string, McpExposure>;
  enabled?: boolean;
  timeout?: number;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: "dcr" | "cimd";
  authServerMetadataUrl?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type?: "http" | "streamable-http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: {
    provider: string;
  };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source: string;
  scope?: "global" | "project" | "extension";
  override?: string;
}

export interface LoadedMcpConfig {
  servers: McpServerEntry[];
  autoEnableCodemode?: boolean;
  errors: string[];
  projectConfig?: string;
}

function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function toolPatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

export function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.search === "" &&
    url.hash === ""
  );
}

function validateOAuth(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "oauth must be an object";
  if (value.clientId !== undefined && typeof value.clientId !== "string")
    return "oauth.clientId must be a string";
  if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
    return "oauth.clientSecret must be a string";
  }
  const port = value.callbackPort;
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    return "oauth.callbackPort must be a port number";
  }
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
  }
  if (value.scope !== undefined && typeof value.scope !== "string")
    return "oauth.scope must be a string";
  if (
    value.clientName !== undefined &&
    (typeof value.clientName !== "string" || !value.clientName.trim())
  ) {
    return "oauth.clientName must be a non-empty string";
  }
  if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
    if (value.clientRegistration !== "cimd")
      return 'oauth.clientRegistration must be "dcr" or "cimd"';
    if (value.clientId !== undefined || value.clientName !== undefined) {
      return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
    }
    const callback = typeof value.callbackUrl === "string" ? new URL(value.callbackUrl) : undefined;
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
      return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
    }
  }
  const metadataUrl = value.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    const url =
      typeof metadataUrl === "string" && URL.canParse(metadataUrl)
        ? new URL(metadataUrl)
        : undefined;
    if (
      !url ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
      )
    ) {
      return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
    }
  }
  return undefined;
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);
}

function resolveExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
  const { exposure, toolExposure } = value;
  const resolved: Record<string, unknown> = { ...value };
  if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
  if (isRecord(toolExposure)) {
    resolved.toolExposure = Object.fromEntries(
      Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
    );
  }
  return resolved;
}

export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[toolName];
  if (exact !== undefined) return exact;
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
  }
  return config.exposure ?? "codemode";
}

export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (!SERVER_NAME.test(name))
    return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const value = resolveExposureAliases(raw);
  const { type, exposure, enabled, timeout, toolExposure, description } = value;
  const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ");
  if (exposure !== undefined && !isExposure(exposure)) {
    return `server "${name}": exposure must be one of ${exposures}`;
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure))
      return `server "${name}": toolExposure must map tool names to exposures`;
    for (const [tool, entry] of Object.entries(toolExposure)) {
      if (!isExposure(entry))
        return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean")
    return `server "${name}": enabled must be a boolean`;
  if (description !== undefined && typeof description !== "string") {
    return `server "${name}": description must be a string`;
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }
  if (type === "sse")
    return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
  if (
    typeof value.url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return `server "${name}": headers must map names to strings`;
    }
    const oauthError = validateOAuth(value.oauth);
    if (oauthError) return `server "${name}": ${oauthError}`;
    if (value.auth !== undefined) {
      if (
        !isRecord(value.auth) ||
        typeof value.auth.provider !== "string" ||
        !value.auth.provider
      ) {
        return `server "${name}": auth.provider must be a provider name`;
      }
      const url = new URL(value.url);
      if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
        return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
      }
    }
    return value as unknown as McpHttpServerConfig;
  }
  if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
    ) {
      return `server "${name}": args must be an array of strings`;
    }
    if (value.env !== undefined && !isStringRecord(value.env))
      return `server "${name}": env must map names to strings`;
    if (value.cwd !== undefined && typeof value.cwd !== "string")
      return `server "${name}": cwd must be a string`;
    return value as unknown as McpStdioServerConfig;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

function readConfigFile(
  path: string,
  scope: "global" | "project",
  state: {
    servers: Map<string, McpServerEntry>;
    autoEnableCodemode?: boolean;
    errors: string[];
  },
): void {
  const { servers, errors } = state;
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: expected an object with an "mcpServers" object`);
    return;
  }
  if (typeof parsed.autoEnableCodemode === "boolean")
    state.autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined)
    errors.push(`${path}: autoEnableCodemode must be a boolean`);

  const mcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  for (const [name, value] of Object.entries(mcpServers)) {
    if (scope === "project" && isRecord(value) && isOverride(value)) {
      const base = servers.get(name);
      const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
      if (!base) {
        errors.push(
          `${path}: server "${name}" needs "command" or "url", or a global server to override`,
        );
      } else if (extra.length > 0) {
        errors.push(
          `${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`,
        );
      } else {
        const config = validateMcpServerConfig(name, { ...base.config, ...value });
        if (typeof config === "string") errors.push(`${path}: ${config}`);
        else servers.set(name, { ...base, config, override: path });
      }
      continue;
    }
    const config = validateMcpServerConfig(name, value);
    if (typeof config === "string") {
      errors.push(`${path}: ${config}`);
      continue;
    }
    const clash = [...servers.keys()].find(
      (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
    );
    if (clash) {
      errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
      continue;
    }
    if (scope === "project" && "url" in config && config.auth) {
      errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
      continue;
    }
    servers.set(name, { name, config, source: path, scope });
  }
}

export function loadMcpConfig(options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
}): LoadedMcpConfig {
  const state: {
    servers: Map<string, McpServerEntry>;
    autoEnableCodemode?: boolean;
    errors: string[];
  } = { servers: new Map(), errors: [] };
  readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
  const projectConfig = options.projectTrusted
    ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json")
    : undefined;
  if (projectConfig) readConfigFile(projectConfig, "project", state);
  return {
    servers: [...state.servers.values()],
    ...(state.autoEnableCodemode === undefined
      ? {}
      : { autoEnableCodemode: state.autoEnableCodemode }),
    errors: state.errors,
    ...(projectConfig ? { projectConfig } : {}),
  };
}

// Config value resolution ($ENV, ${ENV}, !cmd)
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
/** Command results live for the process: a `!command` secret may prompt the user. */
const commandResultCache = new Map<string, string | undefined>();

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previousPart = parts[parts.length - 1];
  if (previousPart?.type === "literal") {
    previousPart.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ type: "env", name });
      } else {
        appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      }
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }
  return parts;
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
  return env?.[name] || process.env[name] || undefined;
}

function resolveShellCommand(config: string): string | undefined {
  if (commandResultCache.has(config)) return commandResultCache.get(config);
  let output: string | undefined;
  try {
    output = execSync(config.slice(1), {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    output = undefined;
  }
  const result = output || undefined;
  commandResultCache.set(config, result);
  return result;
}

function resolveConfigValueOrThrow(
  config: string,
  description: string,
  env?: Record<string, string>,
): string {
  if (config.startsWith("!")) {
    const output = resolveShellCommand(config);
    if (output) return output;
    throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
  }
  const parts = parseConfigValueTemplate(config);
  const missingEnvVars: string[] = [];
  let resolved = "";
  for (const part of parts) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const envValue = resolveEnvConfigValue(part.name, env);
    if (envValue === undefined) {
      if (!missingEnvVars.includes(part.name)) missingEnvVars.push(part.name);
    } else {
      resolved += envValue;
    }
  }
  if (missingEnvVars.length === 1) {
    throw new Error(
      `Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`,
    );
  }
  if (missingEnvVars.length > 1) {
    throw new Error(
      `Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`,
    );
  }
  return resolved;
}

function resolveHeadersOrThrow(
  headers: Record<string, string> | undefined,
  description: string,
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

// OAuth credential storage and provider
export interface McpOAuthSettings {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: "dcr" | "cimd";
  authServerMetadataUrl?: URL;
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

function parseStates(content: string | undefined): Record<string, McpOAuthState> {
  if (!content?.trim()) return {};
  const parsed: unknown = JSON.parse(stripBom(content));
  return isRecord(parsed) ? (parsed as Record<string, McpOAuthState>) : {};
}

function serializeStates(states: Record<string, McpOAuthState>): string {
  return `${JSON.stringify(states, null, 2)}\n`;
}

function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
  const legacyKey = String(new URL(serverUrl));
  return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

interface DirectoryLockOptions {
  staleMs: number;
  waitMs: number;
  retryMs: number;
}

const inProcessWaiters = new Map<string, Set<() => void>>();

function waitForReleaseOrTimeout(lockDir: string, delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    let waiters = inProcessWaiters.get(lockDir);
    if (!waiters) {
      waiters = new Set();
      inProcessWaiters.set(lockDir, waiters);
    }
    const onRelease = () => {
      clearTimeout(timer);
      waiters?.delete(onRelease);
      if (waiters?.size === 0) inProcessWaiters.delete(lockDir);
      resolveWait();
    };
    const timer = setTimeout(onRelease, delayMs);
    waiters.add(onRelease);
  });
}

function notifyInProcessWaiters(lockDir: string): void {
  const waiters = inProcessWaiters.get(lockDir);
  if (!waiters) return;
  inProcessWaiters.delete(lockDir);
  for (const notify of waiters) notify();
}

function lockOwnerPath(lockDir: string): string {
  return join(lockDir, "owner");
}

/**
 * Remove a lock directory. `rm` rather than `rmdir`: the directory holds the owner file, and a
 * directory left by a killed process may still have one.
 */
async function removeLockDir(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
}

async function acquireDirectoryLock(
  targetPath: string,
  options: DirectoryLockOptions,
): Promise<() => Promise<void>> {
  const normalizedTarget = resolve(targetPath);
  const parentDir = dirname(normalizedTarget);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }
  const lockDir = `${normalizedTarget}.lock`;
  const deadline = Date.now() + options.waitMs;
  let allowStaleTakeover = true;

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      // The owner token lets a holder that lost its lock as stale leave the new holder's lock alone.
      const owner = randomBytes(16).toString("hex");
      try {
        await writeFile(lockOwnerPath(lockDir), owner, { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
      } catch (error) {
        await removeLockDir(lockDir);
        throw error;
      }
      const updateIntervalMs = Math.max(500, Math.floor(options.staleMs / 2));
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockDir, now, now).catch(() => undefined);
      }, updateIntervalMs);
      heartbeat.unref();

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        const current = await readFile(lockOwnerPath(lockDir), "utf-8").catch(() => undefined);
        if (current === owner) await removeLockDir(lockDir);
        notifyInProcessWaiters(lockDir);
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;

      if (allowStaleTakeover && options.staleMs > 0) {
        try {
          const stats = await stat(lockDir);
          if (stats.mtimeMs < Date.now() - options.staleMs) {
            await removeLockDir(lockDir);
            allowStaleTakeover = false;
            continue;
          }
        } catch (statError) {
          const statCode =
            statError instanceof Error && "code" in statError ? statError.code : undefined;
          if (statCode === "ENOENT") {
            allowStaleTakeover = false;
            continue;
          }
          throw statError;
        }
      }
      allowStaleTakeover = true;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw Object.assign(new Error(`Lock file is already being held: ${normalizedTarget}`), {
          code: "ELOCKED",
          file: normalizedTarget,
        });
      }
      await waitForReleaseOrTimeout(lockDir, Math.min(options.retryMs, remainingMs));
    }
  }
}

async function withDirectoryLock<T>(
  targetPath: string,
  options: DirectoryLockOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const release = await acquireDirectoryLock(targetPath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export class McpOAuthCredentialStore {
  private readonly authPath: string;
  private readonly lockDir: string;

  constructor(agentDir: string) {
    this.lockDir = resolve(agentDir);
    this.authPath = join(this.lockDir, "mcp-auth.json");
  }

  private readStatesUnlocked(): Record<string, McpOAuthState> {
    if (!existsSync(this.authPath)) return {};
    return parseStates(readFileSync(this.authPath, "utf-8"));
  }

  private writeStatesUnlocked(states: Record<string, McpOAuthState>): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.authPath, serializeStates(states), AUTH_FILE_WRITE_OPTIONS);
  }

  private withAuthFileLock<T>(
    fn: (states: Record<string, McpOAuthState>) => {
      result: T;
      write?: boolean;
    },
  ): Promise<T> {
    return withDirectoryLock(
      this.authPath,
      {
        staleMs: AUTH_LOCK_STALE_MS,
        waitMs: AUTH_LOCK_WAIT_MS,
        retryMs: AUTH_LOCK_RETRY_MS,
      },
      () => {
        const states = this.readStatesUnlocked();
        const { result, write } = fn(states);
        if (write) {
          this.writeStatesUnlocked(states);
        }
        return result;
      },
    );
  }

  forServer(name: string, serverUrl: string): McpOAuthServerStore {
    const { key, legacyKey } = storeKeys(name, serverUrl);
    return {
      load: () =>
        this.withAuthFileLock((states) => {
          if (states[key] || !states[legacyKey]) return { result: states[key] };
          states[key] = states[legacyKey];
          delete states[legacyKey];
          return { result: states[key], write: true };
        }),
      save: (state) =>
        this.withAuthFileLock((states) => {
          states[key] = state;
          return { result: undefined, write: true };
        }),
      withRefreshLock: (fn) => this.withRefreshLock(key, fn),
    };
  }

  private withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return withDirectoryLock(
      join(this.lockDir, `mcp-auth-refresh-${hash}`),
      {
        staleMs: REFRESH_LOCK_STALE_MS,
        waitMs: REFRESH_LOCK_WAIT_MS,
        retryMs: REFRESH_LOCK_RETRY_MS,
      },
      fn,
    );
  }
}

function callbackSettings(settings: McpOAuthSettings): {
  host: string;
  redirectHost: string;
  port: number | undefined;
  path: string;
  fixedRedirectUrl: string | undefined;
} {
  const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
  const address = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : settings.callbackPort;
  let fixedRedirectUrl: string | undefined;
  if (url.port) fixedRedirectUrl = settings.callbackUrl;
  else if (port !== undefined) {
    url.port = String(port);
    fixedRedirectUrl = url.href;
  }
  return {
    host: address === "localhost" ? CALLBACK_HOST : address,
    redirectHost: address,
    port,
    path: url.pathname,
    fixedRedirectUrl,
  };
}

function timedFetch(fetchFn: McpFetch = globalThis.fetch): McpFetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
    return fetchFn(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
  return client && "redirect_uris" in client && Array.isArray(client.redirect_uris)
    ? client.redirect_uris
    : [];
}

function callbackId(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

function clientMetadataDocument(
  serverUrl: string,
  redirectUrl: string,
  metadata:
    | {
        client_id_metadata_document_supported?: boolean;
        token_endpoint_auth_methods_supported?: string[];
        authorization_response_iss_parameter_supported?: boolean;
      }
    | undefined,
): { url: string; redirectUrl: string } {
  if (
    !metadata?.client_id_metadata_document_supported ||
    !metadata.token_endpoint_auth_methods_supported?.includes("none")
  ) {
    throw new Error(
      'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
    );
  }
  if (metadata.authorization_response_iss_parameter_supported) {
    return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl };
  }
  const id = callbackId(serverUrl);
  const redirect = new URL(redirectUrl);
  redirect.pathname = `${CALLBACK_PATH}/${id}`;
  return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href };
}

function createProvider(
  serverUrl: string,
  store: McpOAuthStateStore,
  settings: McpOAuthSettings,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl,
    redirectUrl,
    clientMetadata: { client_name: settings.clientName ?? CLIENT_NAME },
    clientMetadataDocument:
      settings.clientRegistration === "cimd"
        ? (metadata) => clientMetadataDocument(serverUrl, redirectUrl, metadata)
        : undefined,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    store,
    onRedirect,
  });
}

export interface McpAuthProvider extends AuthProvider {
  settled(): Promise<void>;
}

export function createMcpAuthProvider(options: {
  serverUrl: string;
  store: McpOAuthServerStore;
  settings: () => McpOAuthSettings;
  onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
  const { serverUrl, store } = options;
  let refreshing: Promise<void> | undefined;

  const refresh = (
    staleToken: string | undefined,
    fetchFn: McpFetch = globalThis.fetch,
    challenge?: OAuthChallenge,
  ): Promise<void> => {
    refreshing ??= store
      .withRefreshLock(async () => {
        const state = await store.load();
        if (state?.tokens?.access_token !== staleToken) return;
        if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
        const settings = options.settings();
        const redirectUrl =
          callbackSettings(settings).fixedRedirectUrl ??
          registeredRedirectUrls(state.clientInformation)[0] ??
          FALLBACK_REDIRECT_URL;
        const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
        const result = await authorizeMcp(provider, {
          serverUrl,
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
          authorizationServerMetadataUrl: settings.authServerMetadataUrl,
          scope: challenge?.scope,
          fetch: timedFetch(fetchFn),
        });
        if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  return {
    token: async () => {
      await refreshing?.catch(() => undefined);
      const state = await store.load();
      const token = state?.tokens?.access_token;
      const expired =
        state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (!expired || !state?.tokens?.refresh_token) return token;
      await refresh(token).catch(() => undefined);
      return (await store.load())?.tokens?.access_token;
    },
    onUnauthorized: async (context) => {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      options.onChallenge(challenge);
      if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
      await refresh(context.token, context.fetch, challenge);
    },
    settled: async () => {
      await refreshing?.catch(() => undefined);
    },
  };
}

// OAuth sign-in
export class McpSignInCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "McpSignInCancelledError";
  }
}

export interface McpSignInPrompt {
  showAuthorizationUrl(url: URL): void;
  /**
   * Wait for the redirect URL the browser could not deliver, for example when it runs on another
   * machine. Resolves to undefined when the loopback callback should finish the sign-in instead.
   */
  promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export interface McpSignInOptions {
  serverUrl: string;
  store: McpOAuthServerStore;
  settings: McpOAuthSettings;
  challenge?: OAuthChallenge;
  prompt: McpSignInPrompt;
  signal?: AbortSignal;
}

/** Scopes of all lists, each once. */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
  return merged.length > 0 ? merged.join(" ") : undefined;
}

function responseFromRedirectUrl(
  input: string,
  state: string,
  redirectUrl: URL,
): { code: string; iss?: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Expected the full redirect URL from the browser address bar");
  }
  // A server-specific redirect URI tells authorization servers apart, so it must match exactly.
  if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
    throw new Error("The redirect URL does not match this sign-in's redirect URI");
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(url.searchParams.get("error_description") ?? error);
  if (url.searchParams.get("state") !== state) {
    throw new Error("The redirect URL belongs to a different sign-in");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The redirect URL does not contain an authorization code");
  return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/**
 * Wait for the browser callback or a pasted redirect URL, whichever comes first. Aborting `signal`
 * aborts the prompt, which then cancels the sign-in.
 */
async function waitForAuthorizationResponse(
  callback: OAuthCallbackServer,
  state: string,
  redirectUrl: URL,
  prompt: McpSignInPrompt,
  signal: AbortSignal | undefined,
): Promise<{ code: string; iss?: string }> {
  const controller = new AbortController();
  const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname);
  const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
    if (!input?.trim()) throw new McpSignInCancelledError();
    return responseFromRedirectUrl(input, state, redirectUrl);
  });
  try {
    return await Promise.race([fromBrowser, fromUser]);
  } finally {
    // The losing side rejects once the prompt is aborted or the callback server closes.
    controller.abort();
    fromBrowser.catch(() => undefined);
    fromUser.catch(() => undefined);
  }
}

/** Listen on `port`, or on a free port when it is taken and not `required`. */
async function listenForCallback(
  settings: ReturnType<typeof callbackSettings>,
  extraPaths: string[],
  port: number | undefined,
  required: boolean,
): Promise<OAuthCallbackServer> {
  const options = {
    host: settings.host,
    redirectHost: settings.redirectHost,
    path: settings.path,
    extraPaths,
    renderPage: (page: OAuthCallbackPage) =>
      page.ok
        ? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
        : oauthErrorHtml(page.message, page.details),
  };
  try {
    return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
  } catch (error) {
    if (required || port === undefined) throw error;
    return OAuthCallbackServer.listen(options);
  }
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible; otherwise runs the browser
 * authorization code flow against a loopback callback. Tokens are saved through `store`, so they
 * share `mcp-auth.json` and its locks with the running agent. Aborting `signal` stops the sign-in at
 * any step with `McpSignInCancelledError`.
 */
export async function signInMcpServer(options: McpSignInOptions): Promise<void> {
  const { serverUrl, store, settings, signal } = options;
  if (signal?.aborted) throw new McpSignInCancelledError();
  const stored = await store.load();
  const stepUp = options.challenge?.error === "insufficient_scope";
  const callbackOptions = callbackSettings(settings);
  // Reuse the port of the registered redirect URI so the registered client stays valid.
  const registered = registeredRedirectUrls(stored?.clientInformation)[0];
  const preferredPort =
    callbackOptions.port ??
    (registered ? Number(new URL(registered).port) || undefined : undefined);
  const cimd = settings.clientRegistration === "cimd";
  const callback = await listenForCallback(
    callbackOptions,
    // The redirect URI of a server-specific Client ID Metadata Document.
    cimd ? [`${CALLBACK_PATH}/${callbackId(serverUrl)}`] : [],
    preferredPort,
    callbackOptions.port !== undefined,
  );
  const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
  try {
    if (stored) {
      const next = { ...stored };
      // Every sign-in gets a fresh `state` parameter.
      delete next.oauthState;
      // A registered client cannot use another redirect URI, and its tokens belong to it. A Client ID
      // Metadata Document is not stored, so with one, a stored client was registered before and is replaced.
      const keepClient =
        settings.clientId ||
        (cimd
          ? !stored.clientInformation
          : registeredRedirectUrls(stored.clientInformation).includes(redirectUrl));
      if (!keepClient) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      await store.save(next);
    }
    let authorizationUrl: URL | undefined;
    const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
      authorizationUrl = url;
    });
    const flow = {
      serverUrl,
      fetch: timedFetch(),
      signal,
      resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
      authorizationServerMetadataUrl: settings.authServerMetadataUrl,
      // A server asking for more scope gets it on top of the configured scope and, since the challenge
      // may list only the missing scopes, on top of the scope granted so far.
      scope: mergeScopes(
        settings.scope,
        stepUp
          ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope)
          : options.challenge?.scope,
      ),
    };
    // A refresh keeps the granted scope; a server asking for more needs the browser flow.
    if ((await authorizeMcp(provider, { ...flow, skipRefresh: stepUp })) === "AUTHORIZED") return;
    if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");
    const state = await provider.state();
    // The flow picks the redirect URI, which may be specific to the MCP server.
    const authorizationRedirectUrl = new URL(
      authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl,
    );
    options.prompt.showAuthorizationUrl(authorizationUrl);
    const { code, iss } = await waitForAuthorizationResponse(
      callback,
      state,
      authorizationRedirectUrl,
      options.prompt,
      signal,
    );
    await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
  } catch (error) {
    // Aborted requests fail with the signal's reason; report them as the cancellation they are.
    if (signal?.aborted) throw new McpSignInCancelledError();
    throw error;
  } finally {
    await callback.close();
  }
}

// Transport & Server Connection
type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
  entry: McpServerEntry,
  cwd: string,
  authProvider: AuthProvider | undefined,
) => McpTransport;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientError(error: unknown): boolean {
  if (error instanceof McpHttpError) {
    return (
      error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
    );
  }
  return error instanceof TypeError;
}

function signInRequiredMessage(entry: McpServerEntry): string {
  const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
  return provider
    ? `MCP server "${entry.name}" requires sign-in. Run /login ${provider} to sign in.`
    : `MCP server "${entry.name}" requires sign-in. Run \`bun dist/klein mcp login ${entry.name}\` to sign in.`;
}

function usesOAuth(entry: McpServerEntry): boolean {
  const { config } = entry;
  if (!("url" in config) || config.auth) return false;
  return !Object.keys(config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function createDefaultTransport(
  entry: McpServerEntry,
  cwd: string,
  authProvider: AuthProvider | undefined,
): McpTransport {
  const { config, name } = entry;
  if ("url" in config) {
    return new StreamableHttpTransport({
      url: config.url,
      headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
      authProvider,
    });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env ?? {})) {
    env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
  }
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
    env,
    stderr: "pipe",
  });
}

async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound)
      return empty;
    throw error;
  }
}

export class McpServerConnection {
  readonly entry: McpServerEntry;
  state: ServerState = "connecting";
  error: string | undefined;
  tools: McpTool[] = [];
  hasResources = false;
  instructions: string | undefined;
  challenge: OAuthChallenge | undefined;

  private client: McpClient | undefined;
  private opening: Promise<McpClient> | undefined;
  private readonly shutdown = new AbortController();
  private stderrTail: string | undefined;
  private readonly cwd: string;
  private readonly createTransport: McpTransportFactory;
  private readonly authProvider: McpAuthProvider | undefined;
  private readonly onTools: (connection: McpServerConnection) => void;
  private readonly onChange: ((connection: McpServerConnection) => void) | undefined;

  constructor(options: {
    entry: McpServerEntry;
    cwd: string;
    createTransport: McpTransportFactory;
    credentials: McpOAuthCredentialStore;
    providerToken?: (provider: string) => Promise<string | undefined>;
    onTools: (connection: McpServerConnection) => void;
    onChange?: (connection: McpServerConnection) => void;
  }) {
    this.entry = options.entry;
    this.cwd = options.cwd;
    this.createTransport = options.createTransport;
    this.onTools = options.onTools;
    this.onChange = options.onChange;
    const url = this.oauthUrl;
    const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
    this.authProvider = url
      ? createMcpAuthProvider({
          serverUrl: url,
          store: options.credentials.forServer(this.entry.name, url),
          settings: () => this.oauthSettings(),
          onChallenge: (challenge) => {
            this.challenge = challenge;
          },
        })
      : provider
        ? { token: async () => options.providerToken?.(provider), settled: async () => {} }
        : undefined;
  }

  get name(): string {
    return this.entry.name;
  }

  private get closed(): boolean {
    return this.shutdown.signal.aborted;
  }

  get timeoutMs(): number {
    return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  get oauthUrl(): string | undefined {
    return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
  }

  oauthSettings(): McpOAuthSettings {
    const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
    if (!oauth) return {};
    return {
      clientId: oauth.clientId,
      clientSecret:
        oauth.clientSecret === undefined
          ? undefined
          : resolveConfigValueOrThrow(
              oauth.clientSecret,
              `MCP server "${this.entry.name}" oauth.clientSecret`,
            ),
      callbackPort: oauth.callbackPort,
      callbackUrl: oauth.callbackUrl,
      scope: oauth.scope,
      clientName: oauth.clientName,
      clientRegistration: oauth.clientRegistration,
      authServerMetadataUrl: oauth.authServerMetadataUrl
        ? new URL(oauth.authServerMetadataUrl)
        : undefined,
    };
  }

  getClient(): Promise<McpClient> {
    if (this.closed)
      return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
    if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult> {
    return this.withClient((client) => client.callTool(name, args, options));
  }

  readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
    return this.withClient((client) => client.readResource(uri, options), true);
  }

  resourcesPage(
    cursor: string | undefined,
    options: McpRequestOptions,
  ): Promise<ListResourcesResult> {
    return this.withClient((client) => client.listResourcesPage(cursor, options), true);
  }

  resourceTemplatesPage(
    cursor: string | undefined,
    options: McpRequestOptions,
  ): Promise<ListResourceTemplatesResult> {
    return this.withClient(
      (client) =>
        withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), {
          resourceTemplates: [],
        }),
      true,
    );
  }

  allResources(options: McpRequestOptions): Promise<Resource[]> {
    return this.withClient((client) => client.listResources(options), true);
  }

  allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
    return this.withClient(
      (client) => withoutTemplates(() => client.listResourceTemplates(options), []),
      true,
    );
  }

  private async withClient<T>(
    run: (client: McpClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.getClient();
      try {
        return await run(client);
      } catch (error) {
        if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
          await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
          continue;
        }
        if (error instanceof McpSessionExpiredError && attempt === 1) {
          if (this.client === client) this.client = undefined;
          continue;
        }
        if (!this.needsSignIn(error)) throw error;
        await this.dropClient(client);
        this.markNeedsAuth();
        throw new Error(signInRequiredMessage(this.entry));
      }
    }
  }

  private needsSignIn(error: unknown): boolean {
    return (
      error instanceof McpOAuthAuthorizationRequiredError ||
      (this.authProvider !== undefined && error instanceof McpAuthRequiredError)
    );
  }

  private markNeedsAuth(): void {
    this.state = "needs-auth";
    this.error = undefined;
    this.changed();
  }

  private changed(): void {
    this.onChange?.(this);
  }

  private async dropClient(client: McpClient): Promise<void> {
    if (this.client === client) this.client = undefined;
    await client.close().catch(() => undefined);
  }

  private async open(): Promise<McpClient> {
    this.state = "connecting";
    this.changed();
    const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      this.stderrTail = undefined;
      try {
        return await this.connectOnce();
      } catch (error) {
        const delay = retries[attempt];
        if (this.closed || delay === undefined || !isTransientError(error)) {
          throw this.connectFailed(error);
        }
        await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
        if (this.closed) throw this.connectFailed(error);
      }
    }
  }

  private async connectOnce(): Promise<McpClient> {
    const client = new McpClient({
      name: CLIENT_NAME,
      version: CLIENT_VERSION,
      requestTimeoutMs: this.timeoutMs,
      roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
    });
    let closing: Promise<void> | undefined;
    const closeClient = () => {
      closing ??= client.close().catch(() => undefined);
      return closing;
    };
    this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
    let transport: McpTransport | undefined;
    try {
      transport = this.createTransport(this.entry, this.cwd, this.authProvider);
      await client.connect(transport);
      client.onNotification("notifications/tools/list_changed", () => {
        void this.refreshTools(client);
      });
      const stdio = transport instanceof StdioTransport ? transport : undefined;
      client.onClose(() => this.handleClientClose(client, stdio));
      const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
      if (this.closed) throw new Error("shut down while connecting");
      if (client.connectionState !== "connected") throw new Error("connection closed during setup");
      this.client = client;
      this.tools = tools;
      this.hasResources = client.serverCapabilities?.resources !== undefined;
      this.instructions = client.instructions?.trim() || undefined;
      this.state = "connected";
      this.error = undefined;
      this.onTools(this);
      this.changed();
      return client;
    } catch (error) {
      await closeClient();
      if (transport instanceof StdioTransport) {
        this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
      }
      throw error;
    } finally {
      this.shutdown.signal.removeEventListener("abort", closeClient);
    }
  }

  private connectFailed(error: unknown): Error {
    if (this.needsSignIn(error) && !this.closed) {
      this.markNeedsAuth();
      return new Error(signInRequiredMessage(this.entry));
    }
    this.state = this.closed ? "closed" : "failed";
    this.error = this.stderrTail
      ? `${errorMessage(error)}\n${this.stderrTail}`
      : errorMessage(error);
    this.changed();
    return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
  }

  private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
    if (this.client !== client || this.closed) return;
    this.client = undefined;
    this.state = "disconnected";
    const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
    this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
    this.changed();
  }

  private async refreshTools(client: McpClient): Promise<void> {
    try {
      const tools = await client.listTools();
      if (this.client !== client || this.closed) return;
      this.tools = tools;
      this.onTools(this);
    } catch (error) {
      this.error = `Failed to refresh tools: ${errorMessage(error)}`;
    }
    this.changed();
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    this.state = "closed";
    this.changed();
    const client = this.client;
    this.client = undefined;
    await Promise.all([
      client?.close().catch(() => undefined),
      this.opening?.catch(() => undefined),
    ]);
    await this.authProvider?.settled();
  }
}

// Tool & Content Adaptation
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

export async function saveToTempFile(
  data: string | Uint8Array,
  extension: string,
): Promise<string> {
  const path = join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}${extension}`);
  await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
  return path;
}

export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function truncateMiddle(
  content: string,
  maxBytes: number,
): {
  content: string;
  truncated: boolean;
  removedChars: number;
  totalBytes: number;
  totalLines: number;
} {
  const buf = Buffer.from(content, "utf-8");
  const totalLines = splitLinesForCounting(content).length;
  if (buf.length <= maxBytes) {
    return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
  }
  const isBoundary = (index: number) => index >= buf.length || (buf[index]! & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
  const head = buf.subarray(0, headEnd).toString("utf-8");
  const tail = buf.subarray(tailStart).toString("utf-8");
  const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    removedChars,
    totalBytes: buf.length,
    totalLines,
  };
}

const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

const SCHEMA_DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
  if (typeof schema !== "object" || schema === null) return schema;
  const relocated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
      relocated[key] = `${pointer}${value.slice(1)}`;
    } else if (SCHEMA_DATA_KEYWORDS.has(key)) {
      relocated[key] = value;
    } else if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      relocated[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [
          name,
          relocateSchema(subschema, pointer),
        ]),
      );
    } else {
      relocated[key] = relocateSchema(value, pointer);
    }
  }
  return relocated;
}

export function createMcpResultSchema(
  structuredContentSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      structuredContent: structuredContentSchema
        ? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
        : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
    additionalProperties: true,
  };
}

export async function limitMcpContent(
  content: (TextContent | ImageContent)[],
  saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{
  content: (TextContent | ImageContent)[];
  fullOutputPath?: string;
}> {
  const combined = textOf(content);
  const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
  if (!truncation.truncated) return { content };
  let fullOutputPath: string | undefined;
  let where: string;
  try {
    fullOutputPath = await saveOutput(combined, ".txt");
    where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
  } catch (error) {
    where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }
  const tokens = Math.ceil(truncation.totalBytes / 4);
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
  return {
    content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

export interface ConvertMcpResultOptions {
  saveOutput?: McpOutputSaver;
  readableResources?: boolean;
}

async function blockToContent(
  server: string,
  block: ContentBlock,
  options: ConvertMcpResultOptions,
): Promise<(TextContent | ImageContent)[]> {
  if (block.type === "resource_link") {
    const details = [
      block.mimeType,
      block.size === undefined ? undefined : formatSize(block.size),
    ].filter(Boolean);
    const read = options.readableResources
      ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")`
      : "";
    const description = block.description ? `: ${block.description}` : "";
    return [
      {
        type: "text",
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
      },
    ];
  }
  if (
    block.type === "resource" &&
    "blob" in block.resource &&
    !block.resource.mimeType?.startsWith("image/")
  ) {
    const { uri, mimeType, blob } = block.resource;
    const data = Buffer.from(blob, "base64");
    if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
    const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
    try {
      const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
      return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        { type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` },
      ];
    }
  }
  return toLlmContent({ content: [block] });
}

export async function toModelContent(
  server: string,
  blocks: readonly ContentBlock[],
  options: ConvertMcpResultOptions = {},
): Promise<(TextContent | ImageContent)[]> {
  return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

// Pi Durable Tool Registration
export async function loadMcpTools(options: {
  agentDir: string;
  ownerFeaturesAllowed: boolean;
  permissions?: ToolPermissions;
  providerToken?: (provider: string) => Promise<string | undefined>;
  logger: Logger;
  existingNames: Set<string>;
  connections: McpServerConnection[];
}): Promise<ToolRegistration[]> {
  const {
    agentDir,
    ownerFeaturesAllowed,
    permissions,
    providerToken,
    logger,
    existingNames,
    connections,
  } = options;
  const loaded = loadMcpConfig({ agentDir, cwd: process.cwd(), projectTrusted: true });
  for (const error of loaded.errors)
    logger.warn(
      { event: "pi_mcp_config_error", error },
      "Failed to load an MCP server configuration",
    );

  const authorization = new ToolAuthorization(ownerFeaturesAllowed, permissions);
  authorization.rememberServers(loaded.servers.map((server) => server.name));
  const credentials = new McpOAuthCredentialStore(agentDir);
  const connected: Array<{
    entry: (typeof loaded.servers)[number];
    connection: McpServerConnection;
  }> = [];
  for (const entry of loaded.servers) {
    if (entry.config.enabled === false || !authorization.allowsServer(entry.name)) continue;
    const connection = new McpServerConnection({
      entry,
      cwd: process.cwd(),
      createTransport: createDefaultTransport,
      credentials,
      providerToken,
      onTools: () => undefined,
      onChange: (changed) =>
        logger.info(
          { event: "pi_mcp_server_changed", server: changed.name, state: changed.state },
          "MCP server state changed",
        ),
    });
    connections.push(connection);
    try {
      await connection.getClient();
      connected.push({ entry, connection });
    } catch (error) {
      logger.warn(
        { err: error, event: "pi_mcp_server_connect_failed", server: entry.name },
        "Failed to connect to MCP server",
      );
    }
  }

  const tools: ToolRegistration[] = [];
  for (const { entry, connection } of connected) {
    for (const tool of connection.tools) {
      const exposure = getMcpToolExposure(entry.config, tool.name);
      if (exposure === "hidden") continue;
      const name = createMcpToolName(entry.name, tool.name, (candidate) =>
        existingNames.has(candidate),
      );
      existingNames.add(name);
      if (!authorization.allowsTool(name)) continue;
      tools.push(
        defineTool({
          name,
          description: [entry.config.description?.trim(), connection.instructions, tool.description]
            .filter(Boolean)
            .join("\n\n"),
          parameters: Type.Unsafe(tool.inputSchema as never),
          structuredOutputSchema: Type.Unsafe(createMcpResultSchema(tool.outputSchema)),
          deferred: exposure === "deferred" || exposure === "codemode" ? true : undefined,
          callers: exposure === "codemode" ? ["tools"] : undefined,
          replay: tool.annotations?.readOnlyHint ? "safe" : "unsafe",
          async execute(args) {
            const result = await connection.callTool(tool.name, args as Record<string, unknown>, {
              timeoutMs: connection.timeoutMs,
            });
            const modelContent = await toModelContent(entry.name, result.content, {
              readableResources: connection.hasResources,
            });
            const limited = await limitMcpContent(modelContent);
            return {
              output: limited.content,
              structuredOutput: {
                content: result.content,
                ...(result.structuredContent === undefined
                  ? {}
                  : { structuredContent: result.structuredContent }),
                ...(result.isError === undefined ? {} : { isError: result.isError }),
              } as never,
              isError: result.isError,
              details: {
                server: entry.name,
                tool: tool.name,
                ...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
              },
            };
          },
        }),
      );
    }
  }

  const resourceServers = connected
    .filter(
      ({ entry, connection }) => connection.hasResources && authorization.allowsServer(entry.name),
    )
    .map(({ connection }) => connection);
  const resourceExposure = ["direct", "codemode", "deferred"].find((candidate) =>
    connected.some(
      ({ entry, connection }) =>
        connection.hasResources &&
        (entry.config.exposure ?? "codemode") === candidate &&
        authorization.allowsServer(entry.name),
    ),
  ) as "direct" | "codemode" | "deferred" | undefined;
  if (resourceExposure) {
    for (const tool of createDurableMcpResourceTools(resourceExposure, () => resourceServers)) {
      if (!authorization.allowsTool(tool.name)) continue;
      tools.push(tool);
    }
  }
  return tools;
}

function createDurableMcpResourceTools(
  exposure: "direct" | "codemode" | "deferred",
  getServers: () => readonly McpServerConnection[],
): ToolRegistration[] {
  const parameters = Type.Unsafe({
    type: "object",
    properties: {
      server: { type: "string" },
      cursor: { type: "string" },
    },
    additionalProperties: false,
  });
  const outputSchema = Type.Unsafe({ type: "object", additionalProperties: true });
  const options: {
    deferred?: true;
    callers?: readonly ["tools"];
    replay: "safe";
  } = {
    deferred: exposure !== "direct" ? true : undefined,
    callers: exposure === "codemode" ? (["tools"] as const) : undefined,
    replay: "safe" as const,
  };
  const listResources = createMcpResourceListTool(
    LIST_MCP_RESOURCES_TOOL,
    "resources",
    parameters,
    outputSchema,
    options,
    getServers,
  );
  const listTemplates = createMcpResourceListTool(
    LIST_MCP_RESOURCE_TEMPLATES_TOOL,
    "resourceTemplates",
    parameters,
    outputSchema,
    options,
    getServers,
  );
  const readParameters = Type.Unsafe({
    type: "object",
    properties: { server: { type: "string" }, uri: { type: "string" } },
    required: ["server", "uri"],
    additionalProperties: false,
  });
  const readResource = defineTool({
    name: READ_MCP_RESOURCE_TOOL,
    description: "Read a specific resource from an MCP server given its server name and URI.",
    parameters: readParameters,
    structuredOutputSchema: outputSchema,
    deferred: options.deferred,
    callers: options.callers,
    replay: "safe",
    async execute(args) {
      const input = args as { server: string; uri: string };
      const server = getServers().find((candidate) => candidate.name === input.server);
      if (!server) throw new Error(`MCP server does not provide resources: ${input.server}`);
      const resource = await server.readResource(input.uri, {
        timeoutMs: server.timeoutMs,
      });
      const contents = resource.contents.map(({ _meta: _ignored, ...content }) => content);
      const blocks = resource.contents.flatMap((content) => [
        ...(resource.contents.length > 1
          ? [{ type: "text" as const, text: `${content.uri}:` }]
          : []),
        { type: "resource" as const, resource: content },
      ]);
      const modelContent = await toModelContent(server.name, blocks);
      const limited = await limitMcpContent(modelContent);
      return {
        output: limited.content,
        structuredOutput: { server: server.name, uri: input.uri, contents } as never,
        details: {
          server: server.name,
          tool: READ_MCP_RESOURCE_TOOL,
          ...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
        },
      };
    },
  });
  return [listResources, listTemplates, readResource];
}

function createMcpResourceListTool(
  name: string,
  key: "resources" | "resourceTemplates",
  parameters: ReturnType<typeof Type.Unsafe>,
  outputSchema: ReturnType<typeof Type.Unsafe>,
  options: {
    deferred?: true;
    callers?: readonly ["tools"];
    replay: "safe";
  },
  getServers: () => readonly McpServerConnection[],
): ToolRegistration {
  return defineTool({
    name,
    description:
      key === "resources"
        ? "Lists resources provided by MCP servers."
        : "Lists resource templates provided by MCP servers.",
    parameters,
    structuredOutputSchema: outputSchema,
    deferred: options.deferred,
    callers: options.callers,
    replay: options.replay,
    async execute(args) {
      const input = args as { server?: string; cursor?: string };
      const serverName = typeof input.server === "string" ? input.server.trim() : "";
      const cursor = typeof input.cursor === "string" ? input.cursor.trim() : "";
      let payload: Record<string, unknown>;
      if (serverName) {
        const server = getServers().find((candidate) => candidate.name === serverName);
        if (!server) throw new Error(`MCP server does not provide resources: ${serverName}`);
        const requestOptions = { timeoutMs: server.timeoutMs };
        let items: readonly unknown[];
        let nextCursor: string | undefined;
        if (key === "resources") {
          const page = await server.resourcesPage(cursor || undefined, requestOptions);
          items = page.resources;
          nextCursor = page.nextCursor;
        } else {
          const page = await server.resourceTemplatesPage(cursor || undefined, requestOptions);
          items = page.resourceTemplates;
          nextCursor = page.nextCursor;
        }
        payload = {
          server: serverName,
          [key]: items
            .filter((item) => isVisibleMcpResource(item as never))
            .map((item) => ({ server: serverName, ...(item as object) })),
          ...(nextCursor ? { nextCursor } : {}),
        };
      } else {
        if (cursor) throw new Error("cursor can only be used when a server is specified");
        const servers = [...getServers()].sort((a, b) => a.name.localeCompare(b.name));
        const results = await Promise.allSettled(
          servers.map((server) =>
            key === "resources"
              ? server.allResources({ timeoutMs: server.timeoutMs })
              : server.allResourceTemplates({ timeoutMs: server.timeoutMs }),
          ),
        );
        const values: unknown[] = [];
        const errors: { server: string; error: string }[] = [];
        results.forEach((result, index) => {
          const server = servers[index]!;
          if (result.status === "fulfilled") {
            values.push(
              ...result.value
                .filter((item) => isVisibleMcpResource(item as never))
                .map((item) => ({ server: server.name, ...(item as object) })),
            );
          } else {
            errors.push({ server: server.name, error: String(result.reason) });
          }
        });
        payload = { [key]: values, ...(errors.length ? { errors } : {}) };
      }
      const limited = await limitMcpContent([{ type: "text", text: JSON.stringify(payload) }]);
      return {
        output: limited.content,
        structuredOutput: payload as never,
        details: {
          server: serverName,
          tool: name,
          ...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
        },
      };
    },
  });
}

function isVisibleMcpResource(item: {
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
}): boolean {
  const uri = item.uri ?? item.uriTemplate ?? "";
  return !uri.startsWith("ui://") && !/;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");
}
