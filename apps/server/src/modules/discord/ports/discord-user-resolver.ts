import type { DiscordUser } from "../domain/discord-message";

export interface KnownDiscordUser extends DiscordUser {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface DiscordUserResolver {
  resolve(username: string): DiscordUser | undefined;
}

export interface DiscordUserStore {
  load(): Promise<readonly KnownDiscordUser[]>;
  save(users: readonly KnownDiscordUser[]): Promise<void>;
}
