/** Access level shared by channel admission and tool visibility. */
export type AccessLevel = "allow" | "deny" | "owner";

export function isAccessAllowed(level: AccessLevel, ownerSession: boolean): boolean {
  return level === "allow" || (level === "owner" && ownerSession);
}

/** Persisted scope of a scheduled task. */
export type AccessScope = "public" | `owner:${string}`;

export const PUBLIC_ACCESS_SCOPE: AccessScope = "public";

export function ownerAccessScope(userId: string): AccessScope {
  return `owner:${userId}`;
}

export function isOwnerAccessScope(scope: string | undefined, userId: string | undefined): boolean {
  return userId !== undefined && scope === ownerAccessScope(userId);
}
