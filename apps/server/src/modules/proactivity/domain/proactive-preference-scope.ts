import { accessScopeUserId, type AccessScope } from "@shared/access";

export interface ProactivePreferenceTarget {
  readonly channelId: string;
  readonly accessScope: AccessScope;
}

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

export function canUpdateProactivePreferences(
  target: ProactivePreferenceTarget,
  requesterUserId: string | undefined,
  ownerUserId: string | undefined,
): boolean {
  if (requesterUserId === undefined) return false;
  if (target.accessScope === "public") return requesterUserId === ownerUserId;
  return accessScopeUserId(target.accessScope) === requesterUserId;
}
