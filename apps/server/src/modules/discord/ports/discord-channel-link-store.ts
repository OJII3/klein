import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";

/** Persists which Discord user owns each guild channel or thread. */
export interface DiscordChannelLinkStore {
  load(): Promise<void>;
  getLink(target: DiscordChannelLinkTarget): DiscordChannelLink | undefined;
  saveLink(link: DiscordChannelLink): Promise<void>;
}
