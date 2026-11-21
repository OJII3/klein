import type { DiscordUserGuildProfile, DiscordUserProfile } from "../domain/discord-user-profile";

export interface DiscordServiceProfileUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly displayName: string;
  readonly bot: boolean;
  readonly createdAt: Date;
  readonly hexAccentColor?: string | null;
  readonly flags?: { toArray(): readonly string[] } | null;
  avatarURL(options?: { readonly size?: number }): string | null;
  bannerURL(options?: { readonly size?: number }): string | null | undefined;
}

export interface DiscordServiceProfileRole {
  readonly id: string;
  readonly name: string;
  readonly position?: number;
}

export interface DiscordServiceProfileGuildMember {
  readonly nickname: string | null;
  readonly displayName: string;
  readonly joinedAt: Date | null;
  readonly premiumSince: Date | null;
  readonly roles: {
    readonly cache: ReadonlyMap<string, DiscordServiceProfileRole>;
  };
}

export interface DiscordServiceProfileGuild {
  readonly id: string;
  readonly name?: string;
  readonly members: {
    fetch(id: string): Promise<DiscordServiceProfileGuildMember>;
  };
}

export interface DiscordUserProfileSource {
  readonly user: DiscordServiceProfileUser;
  readonly guild?: DiscordServiceProfileGuild;
  readonly member?: DiscordServiceProfileGuildMember;
}

const PROFILE_IMAGE_SIZE = 256;

export function toDiscordUserProfile(source: DiscordUserProfileSource): DiscordUserProfile {
  const { user, guild, member } = source;
  const avatarUrl = user.avatarURL({ size: PROFILE_IMAGE_SIZE });
  const bannerUrl = user.bannerURL({ size: PROFILE_IMAGE_SIZE });
  const guildProfile = guild && member ? toDiscordUserGuildProfile(guild, member) : undefined;

  return {
    id: user.id,
    username: user.username,
    displayName: member?.displayName ?? user.displayName,
    ...(user.globalName ? { globalName: user.globalName } : {}),
    bot: user.bot,
    accountCreatedAt: user.createdAt.toISOString(),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(bannerUrl ? { bannerUrl } : {}),
    ...(user.hexAccentColor ? { accentColor: user.hexAccentColor } : {}),
    flags: user.flags?.toArray() ?? [],
    ...(guildProfile ? { guild: guildProfile } : {}),
  };
}

function toDiscordUserGuildProfile(
  guild: DiscordServiceProfileGuild,
  member: DiscordServiceProfileGuildMember,
): DiscordUserGuildProfile {
  const roles = [...member.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .toSorted((left, right) => (right.position ?? 0) - (left.position ?? 0))
    .map((role) => ({ id: role.id, name: role.name }));

  return {
    id: guild.id,
    name: guild.name ?? guild.id,
    ...(member.nickname ? { nickname: member.nickname } : {}),
    ...(member.joinedAt ? { joinedAt: member.joinedAt.toISOString() } : {}),
    ...(member.premiumSince ? { boostingSince: member.premiumSince.toISOString() } : {}),
    roles,
  };
}
