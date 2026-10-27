export type DiscordAccess = "allow" | "deny" | "owner";

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
  readonly guilds?: Readonly<Record<string, DiscordGuildAccessRule>>;
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
  target: DiscordAccessTarget,
  ownerChannels: ReadonlySet<string>,
): DiscordAccess {
  if (
    ownerChannels.has(target.channelId) ||
    (target.threadId !== undefined && ownerChannels.has(target.threadId))
  ) {
    return "owner";
  }
  if (!target.guildId) return configuration.directMessages;

  const guildRule = configuration.guilds?.[target.guildId];
  const channelRule = guildRule?.channels?.[target.channelId];
  const threadRule = target.threadId ? channelRule?.threads?.[target.threadId] : undefined;

  return threadRule?.access ?? channelRule?.access ?? guildRule?.access ?? configuration.default;
}

export function createDiscordAccessPolicy(
  configuration: DiscordAccessConfiguration,
  ownerUserId?: string,
  ownerChannelIds?: Iterable<string>,
): DiscordAccessPolicy {
  const ownerChannels = new Set(ownerChannelIds ?? []);
  const canUseOwnerFeatures = (target: DiscordAccessTarget): boolean =>
    resolveAccess(configuration, target, ownerChannels) === "owner" &&
    !!ownerUserId &&
    target.userId === ownerUserId &&
    !target.userIsBot;

  return {
    canReceive(target) {
      return (
        resolveAccess(configuration, target, ownerChannels) === "allow" ||
        canUseOwnerFeatures(target)
      );
    },
    resolveAccess: (target) => resolveAccess(configuration, target, ownerChannels),
    canUseOwnerFeatures,
  };
}
