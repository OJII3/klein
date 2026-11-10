import { isAccessAllowed, type AccessLevel } from "@shared/access";

export type DiscordAccess = AccessLevel;

export interface DiscordThreadAccessRule {
  readonly access?: DiscordAccess;
}

export interface DiscordChannelAccessRule {
  readonly access?: DiscordAccess;
  readonly threads?: Readonly<Record<string, DiscordThreadAccessRule>>;
}

export interface DiscordGuildAccessRule {
  readonly access?: DiscordAccess;
  readonly channels?: Readonly<Record<string, DiscordChannelAccessRule>>;
}

export interface DiscordAccessConfiguration {
  readonly default: DiscordAccess;
  readonly directMessages: DiscordAccess;
}

export interface DiscordAccessRules {
  getGuildRule(guildId: string): DiscordGuildAccessRule | undefined;
}

export interface DiscordAccessTarget {
  readonly guildId?: string;
  /** The guild channel, or the parent channel when the target is a thread. */
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly userIsBot?: boolean;
}

export interface DiscordAccessPolicy {
  canReceive(target: DiscordAccessTarget): boolean;
  resolveAccess(target: DiscordAccessTarget): DiscordAccess;
  canUseOwnerFeatures(target: DiscordAccessTarget): boolean;
}

function resolveAccess(
  configuration: DiscordAccessConfiguration,
  rules: DiscordAccessRules | undefined,
  target: DiscordAccessTarget,
): DiscordAccess {
  if (!target.guildId) return configuration.directMessages;

  const guildRule = rules?.getGuildRule(target.guildId);
  const channelRule = guildRule?.channels?.[target.channelId];
  const threadRule = target.threadId ? channelRule?.threads?.[target.threadId] : undefined;

  return threadRule?.access ?? channelRule?.access ?? guildRule?.access ?? configuration.default;
}

export function createDiscordAccessPolicy(
  configuration: DiscordAccessConfiguration,
  ownerUserId?: string,
  rules?: DiscordAccessRules,
): DiscordAccessPolicy {
  const canUseOwnerFeatures = (target: DiscordAccessTarget): boolean =>
    resolveAccess(configuration, rules, target) === "owner" &&
    !!ownerUserId &&
    target.userId === ownerUserId &&
    !target.userIsBot;

  return {
    canReceive(target) {
      return isAccessAllowed(
        resolveAccess(configuration, rules, target),
        canUseOwnerFeatures(target),
      );
    },
    resolveAccess: (target) => resolveAccess(configuration, rules, target),
    canUseOwnerFeatures,
  };
}
