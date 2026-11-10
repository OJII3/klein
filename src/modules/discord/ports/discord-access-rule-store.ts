import type { DiscordAccessRules } from "../domain/discord-access-policy";

/** Loads and serves the Discord access rules that are editable at runtime. */
export interface DiscordAccessRuleStore extends DiscordAccessRules {
  load(): Promise<void>;
}
