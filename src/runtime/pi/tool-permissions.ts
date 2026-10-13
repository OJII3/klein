import type { ExtensionAPI, ExtensionFactory, ToolLoadout } from "@earendil-works/pi-coding-agent";

import { loadMcpConfig } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";

export type ToolAccess = "allow" | "deny" | "owner";
export interface ToolPermissions {
  readonly tools?: {
    readonly default?: ToolAccess;
    readonly overrides?: Readonly<Record<string, ToolAccess>>;
  };
  readonly mcp?: {
    readonly default?: ToolAccess;
    readonly servers?: Readonly<Record<string, ToolAccess>>;
  };
}

/** The session ceiling and current input are trusted application metadata, never model arguments. */
export class ToolAuthorization {
  private currentOwner = false;
  private readonly servers = new Set<string>();
  private readonly toolServers = new Map<string, string>();
  constructor(
    readonly ownerSession: boolean,
    private readonly permissions: ToolPermissions = {},
  ) {}
  rememberServers(names: readonly string[]): void {
    for (const name of names) this.servers.add(name);
  }
  allowsResource(input: Record<string, unknown>): boolean {
    if (typeof input.server === "string") return this.allowsServer(input.server);
    return [...this.servers]
      .filter((name) => this.allowsServer(name, true))
      .every((name) => this.allowsServer(name));
  }
  setPrompt(owner: boolean): void {
    this.currentOwner = this.ownerSession && owner;
  }
  get ownerFeaturesAllowed(): boolean {
    return this.currentOwner;
  }
  allowsServer(name: string, discovery = false): boolean {
    return this.allows(
      this.permissions.mcp?.servers?.[name] ?? this.permissions.mcp?.default ?? "owner",
      discovery,
    );
  }
  allowsTool(name: string, discovery = false): boolean {
    const server = this.toolServers.get(name) ?? /^mcp__(.+?)__/.exec(name)?.[1];
    if (server) {
      const matching = [...this.servers].filter((name) => name.replace(/-/g, "_") === server);
      if (
        !(matching.length ? matching : [server]).every((name) => this.allowsServer(name, discovery))
      )
        return false;
    }
    return this.allows(
      this.permissions.tools?.overrides?.[name] ?? this.permissions.tools?.default ?? "allow",
      discovery,
    );
  }
  private allows(access: ToolAccess, discovery: boolean): boolean {
    return (
      access === "allow" ||
      (access === "owner" && (discovery ? this.ownerSession : this.currentOwner))
    );
  }
  extension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => this.allowsTool(name, true)));
    });
    pi.on("tool_call", (event) => {
      if (
        !this.allowsTool(event.toolName) ||
        (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(
          event.toolName,
        ) &&
          !this.allowsResource(event.input))
      )
        return { block: true, reason: "This tool is not permitted for this input." };
    });
  };
  wrap(factory: ExtensionFactory): ExtensionFactory {
    return (pi) => factory(this.wrapApi(pi));
  }
  private wrapApi(pi: ExtensionAPI): ExtensionAPI {
    const allowed = (name: string) => this.allowsTool(name, true);
    const filterLoadout = (loadout: ToolLoadout): ToolLoadout => ({
      ...loadout,
      declared: loadout.declared.filter((tool) => allowed(tool.name)),
      callable: loadout.callable.filter((tool) => allowed(tool.name)),
      registered: loadout.registered.filter((tool) => allowed(tool.name)),
    });
    return {
      ...pi,
      getAllTools: () => pi.getAllTools().filter((tool) => allowed(tool.name)),
      getMcpServers: () => {
        const servers = pi.getMcpServers();
        this.rememberServers(servers.map((server) => server.name));
        return servers.filter((server) => this.allowsServer(server.name, true));
      },
      setActiveTools: (names) => pi.setActiveTools(names.filter(allowed)),
      registerTool: (tool) => {
        if (tool.namespace?.name.startsWith("mcp__")) {
          const server = tool.namespace.name.slice("mcp__".length);
          this.toolServers.set(tool.name, server);
        }
        pi.registerTool({
          ...tool,
          exposure: allowed(tool.name) ? tool.exposure : "hidden",
          prepareLoadout: tool.prepareLoadout
            ? (loadout) => tool.prepareLoadout!(filterLoadout(loadout))
            : undefined,
          execute: (id, params, signal, update, ctx) => {
            if (
              !this.allowsTool(tool.name) ||
              (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(
                tool.name,
              ) &&
                !this.allowsResource(params as Record<string, unknown>))
            )
              throw new Error("This tool is not permitted for this input.");
            const filteredContext = Object.create(ctx);
            Object.defineProperty(filteredContext, "tools", {
              value: ctx.tools.filter((candidate) => allowed(candidate.name)),
            });
            return tool.execute(id, params, signal, update, filteredContext);
          },
        });
      },
    };
  }
}

// Pi's public entry exposes the MCP extension but not its default config loader. This static
// import also includes the loader in Klein's server bundle, preserving Pi's config semantics.
export const piMcpConfigLoader = loadMcpConfig;
