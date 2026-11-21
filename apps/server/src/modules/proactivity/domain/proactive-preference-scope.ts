import { accessScopeUserId, type AccessScope } from "@shared/access";

/** The conversation whose preferences are read or written. */
export interface ProactivePreferenceTarget {
  readonly channelId: string;
  readonly accessScope: AccessScope;
}

/**
 * Preferences follow a user in private scopes and a channel in public scopes.
 * A linked user keeps the same preferences across their linked channels.
 */
export function proactivePreferenceKey(target: ProactivePreferenceTarget): string {
  if (target.accessScope === "public") {
    return `channel-${encodeURIComponent(target.channelId)}`;
  }
  const userId = accessScopeUserId(target.accessScope);
  if (userId === undefined) {
    throw new Error(`好みの対象が不正です: ${target.accessScope}`);
  }
  return `user-${encodeURIComponent(userId)}`;
}

/**
 * Linked users change their own private preferences. A public channel's
 * preferences are shared by everyone who speaks there, so only the owner may
 * change them.
 */
export function canUpdateProactivePreferences(
  target: ProactivePreferenceTarget,
  requesterUserId: string | undefined,
  ownerUserId: string | undefined,
): boolean {
  if (requesterUserId === undefined) return false;
  if (target.accessScope === "public") return requesterUserId === ownerUserId;
  return accessScopeUserId(target.accessScope) === requesterUserId;
}
