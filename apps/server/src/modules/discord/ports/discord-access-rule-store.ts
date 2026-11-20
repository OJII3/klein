import type { DiscordAccessRuleLevel, DiscordAccessRules } from "../domain/discord-access-policy";

export interface DiscordAccessRuleTarget {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

/** Loads and serves the Discord access rules that are editable at runtime. */
export interface DiscordAccessRuleStore extends DiscordAccessRules {
  load(): Promise<void>;
  setAccess(target: DiscordAccessRuleTarget, access: DiscordAccessRuleLevel): Promise<void>;
}
