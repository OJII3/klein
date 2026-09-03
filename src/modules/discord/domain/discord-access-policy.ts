export type DiscordAccess = "allow" | "deny";

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
}

export interface DiscordAccessPolicy {
  canReceive(target: DiscordAccessTarget): boolean;
}

function resolveAccess(
  configuration: DiscordAccessConfiguration,
  target: DiscordAccessTarget,
): DiscordAccess {
  if (!target.guildId) return configuration.directMessages;

  const guildRule = configuration.guilds?.[target.guildId];
  const channelRule = guildRule?.channels?.[target.channelId];
  const threadRule = target.threadId ? channelRule?.threads?.[target.threadId] : undefined;

  return threadRule?.access ?? channelRule?.access ?? guildRule?.access ?? configuration.default;
}

export function createDiscordAccessPolicy(
  configuration: DiscordAccessConfiguration,
): DiscordAccessPolicy {
  return {
    canReceive(target) {
      return resolveAccess(configuration, target) === "allow";
    },
  };
}
