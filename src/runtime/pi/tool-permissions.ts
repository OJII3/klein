import type { ExtensionAPI, ExtensionFactory, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { isAccessAllowed, type AccessLevel } from "@shared/access";

const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

export type ToolAccess = AccessLevel;
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
    readonly ownerSession: boolean,
    private readonly permissions: ToolPermissions = {},
    private readonly alwaysAllowedTools: ReadonlySet<string> = new Set(),
  ) {}
  rememberServers(names: readonly string[]): void {
    for (const name of names) this.servers.add(name);
  }
  allowsResource(input: Record<string, unknown>): boolean {
    if (typeof input.server === "string") return this.allowsServer(input.server);
    // Listings only include servers exposed by the session's filtered MCP API.
    return true;
  }
  allowsServer(name: string): boolean {
    return this.allows(
      this.permissions.mcp?.servers?.[name] ?? this.permissions.mcp?.default ?? "owner",
    );
  }
  allowsTool(name: string): boolean {
    if (this.alwaysAllowedTools.has(name)) return true;
    const server = /^mcp__(.+?)__/.exec(name)?.[1];
    if (server) {
      const matching = [...this.servers].filter((name) => name.replaceAll("-", "_") === server);
      if (!(matching.length ? matching : [server]).every((name) => this.allowsServer(name)))
        return false;
    }
    return this.allows(
      this.permissions.tools?.overrides?.[name] ?? this.permissions.tools?.default ?? "allow",
    );
  }
  private allows(access: ToolAccess): boolean {
    return isAccessAllowed(access, this.ownerSession);
  }
  extension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => this.allowsTool(name)));
    });
    pi.on("tool_call", (event) => {
      if (
        !this.allowsTool(event.toolName) ||
        (MCP_RESOURCE_TOOLS.has(event.toolName) && !this.allowsResource(event.input))
      )
        return { block: true, reason: "This tool is not permitted for this input." };
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
      setActiveTools: (names) => pi.setActiveTools(names.filter(allowed)),
      registerTool: (tool) => {
        pi.registerTool({
          ...tool,
          exposure: allowed(tool.name) ? tool.exposure : "hidden",
          prepareLoadout: tool.prepareLoadout
            ? (loadout) => tool.prepareLoadout!(filterLoadout(loadout))
            : undefined,
          execute: (id, params, signal, update, ctx) => {
            if (
              !this.allowsTool(tool.name) ||
              (MCP_RESOURCE_TOOLS.has(tool.name) &&
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
