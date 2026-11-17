import type { DiscordUser } from "./discord-message";

const DISCORD_USERNAME_MAX_LENGTH = 100;

export interface DiscordUserResolver {
  resolve(username: string): DiscordUser | undefined;
}

export function normalizeDiscordUsername(value: string): string {
  return value.trim().replace(/^@+/u, "").trim().toLowerCase();
}

export function isValidDiscordUsername(value: string): boolean {
  return (
    value.length > 0 && value.length <= DISCORD_USERNAME_MAX_LENGTH && /^[^\s/\\]+$/u.test(value)
  );
}

export function isValidDiscordUserId(value: string): boolean {
  return /^\d+$/.test(value);
}
