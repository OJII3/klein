export interface DiscordUserProfileRole {
  readonly id: string;
  readonly name: string;
}

export interface DiscordUserGuildProfile {
  readonly id: string;
  readonly name: string;
  readonly nickname?: string;
  readonly joinedAt?: string;
  readonly boostingSince?: string;
  /** Highest roles first. The @everyone role is omitted. */
  readonly roles: readonly DiscordUserProfileRole[];
}

/**
 * The profile fields Discord exposes to a bot. About Me (bio) and presence are
 * not part of the bot API surface, so they never appear here.
 */
export interface DiscordUserProfile {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly globalName?: string;
  readonly bot: boolean;
  readonly accountCreatedAt: string;
  readonly avatarUrl?: string;
  readonly bannerUrl?: string;
  readonly accentColor?: string;
  readonly flags: readonly string[];
  readonly guild?: DiscordUserGuildProfile;
}
