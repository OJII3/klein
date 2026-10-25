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

/** Session permissions are trusted application metadata, never model arguments. */
export class ToolAuthorization {
  private readonly servers = new Set<string>();
  constructor(
    readonly ownerSession: boolean,
    private readonly permissions: ToolPermissions = {},
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
    const server = /^mcp__(.+?)__/.exec(name)?.[1];
    if (server) {
      const matching = [...this.servers].filter((name) => name.replace(/-/g, "_") === server);
      if (!(matching.length ? matching : [server]).every((name) => this.allowsServer(name)))
        return false;
    }
    return this.allows(
      this.permissions.tools?.overrides?.[name] ?? this.permissions.tools?.default ?? "allow",
    );
  }
  private allows(access: ToolAccess): boolean {
    return access === "allow" || (access === "owner" && this.ownerSession);
  }
}
