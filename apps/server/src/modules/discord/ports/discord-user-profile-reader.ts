import type { DiscordUserProfile } from "../domain/discord-user-profile";

export interface DiscordUserProfileReader {
  /**
   * Reads a user's Discord profile. When `guildId` is present, the result also
   * contains that server's nickname, join date, roles, and boosting status.
   * Returns `undefined` when Discord does not expose the user.
   */
  readUserProfile(userId: string, guildId?: string): Promise<DiscordUserProfile | undefined>;
}
