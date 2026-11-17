/** Prefix shared by every Pi session key that belongs to a Discord channel. */
export const DISCORD_CHANNEL_SESSION_KEY_PREFIX = "discord-channel:";

/**
 * Reads the Discord channel id from a session key such as
 * `discord-channel:123`, `discord-channel:123:owner:456`, or
 * `discord-channel:123:public:rotation:2026-11-10T12`.
 */
export function parseDiscordChannelId(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith(DISCORD_CHANNEL_SESSION_KEY_PREFIX)) return undefined;
  const channelId = sessionKey.slice(DISCORD_CHANNEL_SESSION_KEY_PREFIX.length).split(":", 1)[0];
  return channelId || undefined;
}
