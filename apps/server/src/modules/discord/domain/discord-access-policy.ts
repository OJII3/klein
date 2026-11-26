import { isAccessAllowed, type AccessLevel } from "@shared/access";

import type { DiscordChannelLinkTarget } from "./discord-channel-link";

export type DiscordAccess = AccessLevel;

export type DiscordAccessRuleLevel = "allow" | "deny";

export interface DiscordThreadAccessRule {
  readonly access?: DiscordAccessRuleLevel;
}

export interface DiscordChannelAccessRule {
  readonly access?: DiscordAccessRuleLevel;
  readonly threads?: Readonly<Record<string, DiscordThreadAccessRule>>;
}

export interface DiscordGuildAccessRule {
  readonly access?: DiscordAccessRuleLevel;
  readonly channels?: Readonly<Record<string, DiscordChannelAccessRule>>;
}

export interface DiscordAccessConfiguration {
  readonly default: DiscordAccess;
  readonly directMessages: DiscordAccess;
}

export interface DiscordAccessRules {
  getGuildRule(guildId: string): DiscordGuildAccessRule | undefined;
}

export type DiscordChannelOwnerResolver = (target: DiscordChannelLinkTarget) => string | undefined;

export interface DiscordAccessTarget {
  readonly guildId?: string;
  /** The guild channel, or the parent channel when the target is a thread. */
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly userIsBot?: boolean;
}

/**
 * Why: the message path admits a non-owner human into an owner channel, while interaction,
 * reaction, choice, and voice paths keep using `canReceive` and deny that sender.
 */
export type DiscordAdmission = "owner" | "linked" | "public" | "bystander" | "denied";

export interface DiscordAccessPolicy {
  canReceive(target: DiscordAccessTarget): boolean;
  /** Why: the message path needs a separate gate so bystanders reach only the owner session. */
  canReceiveMessage(target: DiscordAccessTarget): boolean;
  resolveAdmission(target: DiscordAccessTarget): DiscordAdmission;
  resolveAccess(target: DiscordAccessTarget): DiscordAccess;
  canUseOwnerFeatures(target: DiscordAccessTarget): boolean;
  resolveLinkedUser(target: DiscordAccessTarget): string | undefined;
}

function isOwner(ownerUserId: string | undefined, target: DiscordAccessTarget): boolean {
  return !!ownerUserId && target.userId === ownerUserId && !target.userIsBot;
}

function resolveAccess(
  configuration: DiscordAccessConfiguration,
  rules: DiscordAccessRules | undefined,
  ownerUserId: string | undefined,
  resolveChannelOwner: DiscordChannelOwnerResolver | undefined,
  target: DiscordAccessTarget,
): DiscordAccess {
  if (!target.guildId) {
    return isOwner(ownerUserId, target) ? "owner" : configuration.directMessages;
  }

  const linkedOwner = resolveChannelOwner?.({
    guildId: target.guildId,
    channelId: target.channelId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
  });
  if (linkedOwner) {
    return linkedOwner === ownerUserId ? "owner" : "allow";
  }

  const guildRule = rules?.getGuildRule(target.guildId);
  const channelRule = guildRule?.channels?.[target.channelId];
  const threadRule = target.threadId ? channelRule?.threads?.[target.threadId] : undefined;

  return threadRule?.access ?? channelRule?.access ?? guildRule?.access ?? configuration.default;
}

export function createDiscordAccessPolicy(
  configuration: DiscordAccessConfiguration,
  ownerUserId?: string,
  rules?: DiscordAccessRules,
  resolveChannelOwner?: DiscordChannelOwnerResolver,
): DiscordAccessPolicy {
  const canUseOwnerFeatures = (target: DiscordAccessTarget): boolean =>
    resolveAccess(configuration, rules, ownerUserId, resolveChannelOwner, target) === "owner" &&
    isOwner(ownerUserId, target);

  const resolveLinkedUser = (target: DiscordAccessTarget): string | undefined => {
    if (target.userIsBot || !target.guildId || !target.userId) return undefined;
    const linkedUser = resolveChannelOwner?.({
      guildId: target.guildId,
      channelId: target.channelId,
      ...(target.threadId ? { threadId: target.threadId } : {}),
    });
    return linkedUser === target.userId ? linkedUser : undefined;
  };

  const resolveAdmission = (target: DiscordAccessTarget): DiscordAdmission => {
    const access = resolveAccess(configuration, rules, ownerUserId, resolveChannelOwner, target);
    if (access === "deny") return "denied";
    if (access === "allow") return resolveLinkedUser(target) ? "linked" : "public";

    // Why: without a configured owner there is no way to tell the owner from a bystander.
    if (!ownerUserId) return "denied";
    if (isOwner(ownerUserId, target)) return "owner";
    // Security: a non-owner DM stays denied because folding it into the owner session would expose owner context.
    if (!target.guildId || !target.userId || target.userIsBot) return "denied";
    return "bystander";
  };

  return {
    canReceive(target) {
      return isAccessAllowed(
        resolveAccess(configuration, rules, ownerUserId, resolveChannelOwner, target),
        canUseOwnerFeatures(target),
      );
    },
    canReceiveMessage(target) {
      return resolveAdmission(target) !== "denied";
    },
    resolveAdmission,
    resolveAccess: (target) =>
      resolveAccess(configuration, rules, ownerUserId, resolveChannelOwner, target),
    canUseOwnerFeatures,
    resolveLinkedUser,
  };
}
