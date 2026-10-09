export interface DiscordChannelRuleStore {
  get(guildId: string, channelId: string): Promise<string | undefined>;
  set(guildId: string, channelId: string, rule: string): Promise<void>;
}
