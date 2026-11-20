/** Access level shared by channel admission and tool visibility. */
export type AccessLevel = "allow" | "deny" | "owner";

export function isAccessAllowed(level: AccessLevel, ownerSession: boolean): boolean {
  return level === "allow" || (level === "owner" && ownerSession);
}

/** Persisted scope of a private conversation, worker, or scheduled task. */
export type AccessScope = "public" | `owner:${string}` | `user:${string}`;

export const PUBLIC_ACCESS_SCOPE: AccessScope = "public";

export function ownerAccessScope(userId: string): AccessScope {
  return `owner:${userId}`;
}

/** Private scope of a user who linked a channel, without owner features. */
export function userAccessScope(userId: string): AccessScope {
  return `user:${userId}`;
}

export function parseAccessScope(value: unknown): AccessScope | undefined {
  if (value === PUBLIC_ACCESS_SCOPE) return PUBLIC_ACCESS_SCOPE;
  if (typeof value !== "string") return undefined;
  for (const prefix of ["owner:", "user:"] as const) {
    if (!value.startsWith(prefix)) continue;
    const userId = value.slice(prefix.length);
    if (userId.length === 0) return undefined;
    return `${prefix}${userId}`;
  }
  return undefined;
}

/** The user whose private session the scope belongs to. Public scopes have none. */
export function accessScopeUserId(scope: AccessScope | undefined): string | undefined {
  if (!scope) return undefined;
  for (const prefix of ["owner:", "user:"] as const) {
    if (scope.startsWith(prefix)) return scope.slice(prefix.length);
  }
  return undefined;
}

export function isOwnerAccessScope(scope: string | undefined, userId: string | undefined): boolean {
  return userId !== undefined && scope === ownerAccessScope(userId);
}
