import type { DiscordAccessRuleLevel, DiscordAccessRules } from "../domain/discord-access-policy";

export interface DiscordAccessRuleTarget {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

export interface DiscordAccessRuleStore extends DiscordAccessRules {
  load(): Promise<void>;
  setAccess(target: DiscordAccessRuleTarget, access: DiscordAccessRuleLevel): Promise<void>;
}
