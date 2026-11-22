import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionToolContext,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "@shared/type-guards";

const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

export type ToolSessionAccess = "public" | "user" | "owner";

/** Permission level for a tool or MCP server. `user` includes the owner. */
export type ToolAccess = "allow" | "deny" | "user" | "owner";

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

/** Session permissions are trusted application metadata, never model arguments. */
export class ToolAuthorization {
  private readonly servers = new Set<string>();
  constructor(
    readonly sessionAccess: ToolSessionAccess,
    private readonly permissions: ToolPermissions = {},
    private readonly alwaysAllowedTools: ReadonlySet<string> = new Set(),
    /** Application-registered servers and the level they require by default. */
    private readonly builtinServerAccess: Readonly<Record<string, ToolAccess>> = {},
  ) {}
  rememberServers(names: readonly string[]): void {
    for (const name of names) this.servers.add(name);
  }
  allowsResource(input: unknown): boolean {
    if (isRecord(input) && typeof input.server === "string") {
      return this.allowsServer(input.server);
    }
    // Listings only include servers exposed by the session's filtered MCP API.
    return true;
  }
  allowsServer(name: string): boolean {
    return this.allows(
      this.permissions.mcp?.servers?.[name] ??
        this.builtinServerAccess[name] ??
        this.permissions.mcp?.default ??
        "owner",
    );
  }
  allowsTool(name: string): boolean {
    if (this.alwaysAllowedTools.has(name)) return true;
    const server = /^mcp__(.+?)__/.exec(name)?.[1];
    if (server) {
      const matching = [...this.servers].filter(
        (serverName) => serverName.replaceAll("-", "_") === server,
      );
      if (
        !(matching.length ? matching : [server]).every((serverName) =>
          this.allowsServer(serverName),
        )
      )
        return false;
    }
    return this.allows(
      this.permissions.tools?.overrides?.[name] ?? this.permissions.tools?.default ?? "allow",
    );
  }
  private allows(access: ToolAccess): boolean {
    if (access === "allow") return true;
    if (access === "deny") return false;
    if (access === "user") return this.sessionAccess !== "public";
    return this.sessionAccess === "owner";
  }
  extension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => this.allowsTool(name)));
    });
    pi.on("tool_call", (event) => {
      if (
        !this.allowsTool(event.toolName) ||
        (MCP_RESOURCE_TOOLS.has(event.toolName) && !this.allowsResource(event.input))
      ) {
        return { block: true, reason: "This tool is not permitted for this input." };
      }
      return undefined;
    });
  };
  wrap(factory: ExtensionFactory): ExtensionFactory {
    return (pi) => factory(this.wrapApi(pi));
  }
  private wrapApi(pi: ExtensionAPI): ExtensionAPI {
    const allowed = (name: string) => this.allowsTool(name);
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
        return servers.filter((server) => this.allowsServer(server.name));
      },
      setActiveTools: (names) => pi.setActiveTools(names.filter((name) => allowed(name))),
      registerTool: (tool) => {
        const prepareLoadout = tool.prepareLoadout;
        pi.registerTool({
          ...tool,
          exposure: allowed(tool.name) ? tool.exposure : "hidden",
          prepareLoadout: prepareLoadout
            ? (loadout) => prepareLoadout(filterLoadout(loadout))
            : undefined,
          execute: (id, params, signal, update, ctx) => {
            if (
              !this.allowsTool(tool.name) ||
              (MCP_RESOURCE_TOOLS.has(tool.name) && !this.allowsResource(params))
            )
              throw new Error("This tool is not permitted for this input.");
            const filteredContext: ExtensionToolContext = {
              get ui() {
                return ctx.ui;
              },
              get mode() {
                return ctx.mode;
              },
              get hasUI() {
                return ctx.hasUI;
              },
              get cwd() {
                return ctx.cwd;
              },
              get sessionManager() {
                return ctx.sessionManager;
              },
              get modelRegistry() {
                return ctx.modelRegistry;
              },
              get model() {
                return ctx.model;
              },
              get scopedModels() {
                return ctx.scopedModels;
              },
              get thinkingLevel() {
                return ctx.thinkingLevel;
              },
              get signal() {
                return ctx.signal;
              },
              isIdle: () => ctx.isIdle(),
              isProjectTrusted: () => ctx.isProjectTrusted(),
              abort: () => ctx.abort(),
              hasPendingMessages: () => ctx.hasPendingMessages(),
              shutdown: () => ctx.shutdown(),
              getContextUsage: () => ctx.getContextUsage(),
              compact: (options) => ctx.compact(options),
              getSystemPrompt: () => ctx.getSystemPrompt(),
              tools: ctx.tools.filter((candidate) => allowed(candidate.name)),
              executeTool: (name, args, options) => ctx.executeTool(name, args, options),
            };
            return tool.execute(id, params, signal, update, filteredContext);
          },
        });
      },
    };
  }
}
